# Attachments: signed uploads, claims, and the sign-in route

Screenshots are the most useful part of a bug report and the most sensitive: a screen of the app shows
whatever the member was looking at, customers' names included. The bytes never pass through a Server
Action and never get a public URL.

| Step | Where | What is checked |
|---|---|---|
| Reserve | `prepareUpload` action, `reserveUpload` | Member signed in; type in the list; size under the per-type cap; row inserted under RLS in the tenant's folder |
| Upload | Browser, `uploadToSignedUrl` | The bucket's own size and type limits |
| Claim | `createReport` or `addComment`, `claimAttachments` | The uploader's own unclaimed rows; the object exists at the reserved size and type |
| Read | `/api/bug-reports/attachments/[id]` | Operator, or member of the report's tenant; otherwise 404 |
| Sweep | The worker | Reservations unclaimed after a day: object and row deleted |

Limits: ten files a report or comment; 10 MB for an image, 25 MB for a PDF, text file or video. PNG, JPEG,
WebP, GIF, PDF, plain text, MP4 and WebM. SVG and HTML are refused at every step: opened from a signed URL
on the storage origin, they run script.

## Server

```typescript
// server/bug-reports/attachments.ts
import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { REPORT_LIMITS, isAllowedMime, maxBytesFor } from "@/lib/bug-reports/types";
import type { Member } from "./host";

/**
 * Bytes never pass through a Server Action, whose body limit is 1 MB: the action reserves a row and signs
 * an upload URL into the private bucket, the browser uploads, and saving the report claims the rows
 * after checking that each object landed at the size and type the row promised.
 */
export const REPORT_BUCKET = "bug-report-attachments";

/** A readable name that cannot escape its folder or break a header. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  return cleaned || "file";
}

export type UploadTicket = { attachmentId: string; path: string; token: string };

export async function reserveUpload(
  member: Member,
  session: SupabaseClient,
  service: SupabaseClient,
  input: { fileName: string; mimeType: string; size: number },
): Promise<UploadTicket | { refused: "type" | "empty" | "size" }> {
  if (!isAllowedMime(input.mimeType)) return { refused: "type" };
  if (!Number.isFinite(input.size) || input.size <= 0) return { refused: "empty" };
  if (input.size > maxBytesFor(input.mimeType)) return { refused: "size" };

  const id = randomUUID();
  const path = `${member.tenantId}/${id}/${safeFileName(input.fileName)}`;
  const { error } = await session.from("bug_report_attachments").insert({
    id,
    tenant_id: member.tenantId,
    uploaded_by: member.id,
    storage_path: path,
    file_name: input.fileName.slice(0, 200) || "file",
    mime_type: input.mimeType,
    size_bytes: Math.round(input.size),
  });
  if (error) throw new Error(`attachment reserve: ${error.message}`);

  const { data, error: signError } = await service.storage.from(REPORT_BUCKET).createSignedUploadUrl(path);
  if (signError || !data) throw new Error(`attachment sign: ${signError?.message ?? "no data"}`);
  return { attachmentId: id, path: data.path, token: data.token };
}

/**
 * Bind uploads to a saved report or comment. Only the uploader's own unclaimed rows qualify, and only
 * when the object exists at the promised size and type: a reservation alone attaches nothing.
 */
export async function claimAttachments(
  service: SupabaseClient,
  member: Pick<Member, "id" | "tenantId">,
  ids: readonly string[],
  target: { reportId: string; commentId?: string | null },
): Promise<{ id: string; fileName: string }[]> {
  const unique = [...new Set(ids)].slice(0, REPORT_LIMITS.maxFiles);
  if (unique.length === 0) return [];
  const { data, error } = await service
    .from("bug_report_attachments")
    .select("id, storage_path, file_name, mime_type")
    .in("id", unique)
    .eq("tenant_id", member.tenantId)
    .eq("uploaded_by", member.id)
    .is("report_id", null)
    .is("comment_id", null);
  if (error) throw new Error(`attachment claim: ${error.message}`);

  const claimed: { id: string; fileName: string }[] = [];
  for (const row of data ?? []) {
    const { data: info } = await service.storage.from(REPORT_BUCKET).info(row.storage_path as string);
    if (!info) continue; // never uploaded: the sweep removes the row
    const size = info.size ?? 0;
    const type = info.contentType;
    if (size <= 0 || size > maxBytesFor(row.mime_type as string) || (type && type !== row.mime_type)) continue;
    const { error: bindError } = await service
      .from("bug_report_attachments")
      .update({ report_id: target.reportId, comment_id: target.commentId ?? null, status: "ready", size_bytes: size })
      .eq("id", row.id)
      .is("report_id", null);
    if (bindError) throw new Error(`attachment bind: ${bindError.message}`);
    claimed.push({ id: row.id as string, fileName: row.file_name as string });
  }
  return claimed;
}

export type AttachmentRow = { id: string; tenant_id: string; storage_path: string; file_name: string; mime_type: string; status: string };

/** Sixty seconds. Anything that is not an image, a PDF or a video downloads rather than renders. */
export async function signedAttachmentUrl(service: SupabaseClient, row: AttachmentRow, ttlSeconds = 60): Promise<string | null> {
  const inline = /^(image|video)\//.test(row.mime_type) || row.mime_type === "application/pdf";
  const { data } = await service.storage
    .from(REPORT_BUCKET)
    .createSignedUrl(row.storage_path, ttlSeconds, inline ? undefined : { download: row.file_name });
  return data?.signedUrl ?? null;
}

/** Reservations nobody saved a report with, older than a day: the object and the row both go. */
export async function sweepOrphanAttachments(service: SupabaseClient, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const { data } = await service.from("bug_report_attachments").select("id, storage_path").is("report_id", null).lt("created_at", cutoff).limit(200);
  const rows = data ?? [];
  if (rows.length === 0) return 0;
  await service.storage.from(REPORT_BUCKET).remove(rows.map((r) => r.storage_path as string));
  await service.from("bug_report_attachments").delete().in("id", rows.map((r) => r.id as string));
  return rows.length;
}
```

A reservation is not an attachment. The claim reads each object's metadata and binds only what really
landed, at the size and type the row promised; a client that reserves ten rows and uploads one attaches
one, and the other nine are swept.

## The route

```typescript
// app/api/bug-reports/attachments/[id]/route.ts
import { NextResponse } from "next/server";
import { bugReportsHost } from "@/server/bug-reports/host";
import { signedAttachmentUrl, type AttachmentRow } from "@/server/bug-reports/attachments";

/**
 * An attachment behind a sign-in. The issue links here, on the operator origin, rather than to the
 * bucket, so a screenshot with a customer's name on it is never a public URL. Allowed: an operator, or a
 * member of the report's tenant. Everyone else gets 404, never 403, so an id cannot be probed. An
 * anonymous visitor goes to sign-in and comes back here.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();

  const [operator, member] = await Promise.all([bugReportsHost.currentOperator(), bugReportsHost.currentMember()]);
  if (!operator && !member) {
    const returnTo = new URL(request.url).pathname;
    return NextResponse.redirect(new URL(bugReportsHost.loginUrl(returnTo), request.url), 302);
  }

  const db = bugReportsHost.serviceDb();
  const { data } = await db
    .from("bug_report_attachments")
    .select("id, tenant_id, storage_path, file_name, mime_type, status")
    .eq("id", id)
    .maybeSingle();
  const row = data as AttachmentRow | null;
  if (!row || row.status !== "ready") return notFound();
  if (!operator && member?.tenantId !== row.tenant_id) return notFound();

  const url = await signedAttachmentUrl(db, row);
  if (!url) return notFound();
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
```

- **404 rather than 403** for a member of another tenant, so an id cannot be probed for existence.
- **A redirect to a 60-second signed URL**, `no-store` and `no-referrer`, so the URL neither caches nor
  leaks through a referrer header. A link copied out of the issue works only for someone who can sign in.
- **An anonymous visitor goes to sign-in with a return path.** Operators open these links from GitHub,
  usually before they have a session on the operator host; landing them on the app's home page after
  signing in loses the file. The host's sign-in route must honour the return parameter `loginUrl` builds.
- **Non-images download** (`download` option) rather than render on the storage origin.

## Browser

```tsx
// components/bug-reports/AttachmentPicker.tsx
"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { REPORT_LIMITS, isAllowedMime, maxBytesFor } from "@/lib/bug-reports/types";
import { prepareUpload } from "@/app/bug-reports/actions";
import { useReportStrings } from "./use-strings";

const BUCKET = "bug-report-attachments";

export type UploadItem = { key: string; name: string; size: number; state: "uploading" | "ready" | "error"; attachmentId?: string; error?: string };

function browserDb() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

/**
 * Files straight from the browser into the private bucket: the action reserves a row and signs an upload
 * URL, the bytes go to Storage, and only the ids travel with the report. Drop, paste or pick; a pasted
 * screenshot has no name, so it gets one.
 */
export function useAttachmentUploads() {
  const t = useReportStrings();
  const [items, setItems] = useState<UploadItem[]>([]);
  const seq = useRef(0);
  const patch = (key: string, next: Partial<UploadItem>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...next } : i)));

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const key = `${Date.now()}-${seq.current++}`;
        const mime = file.type || "application/octet-stream";
        const name = file.name || `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
        let error: string | null = null;
        if (!isAllowedMime(mime)) error = t("fileType");
        else if (file.size > maxBytesFor(mime)) error = t("fileTooLarge", { mb: Math.round(maxBytesFor(mime) / 1024 / 1024) });
        setItems((list) => {
          if (list.filter((i) => i.state !== "error").length >= REPORT_LIMITS.maxFiles) {
            return [...list, { key, name, size: file.size, state: "error", error: t("tooManyFiles", { max: REPORT_LIMITS.maxFiles }) }];
          }
          return [...list, { key, name, size: file.size, state: error ? "error" : "uploading", error: error ?? undefined }];
        });
        if (error) continue;
        void (async () => {
          const ticket = await prepareUpload({ fileName: name, mimeType: mime, size: file.size });
          if (!ticket.ok) return patch(key, { state: "error", error: t("uploadFailed") });
          const { error: upErr } = await browserDb().storage.from(BUCKET).uploadToSignedUrl(ticket.value.path, ticket.value.token, file, { contentType: mime });
          if (upErr) return patch(key, { state: "error", error: t("uploadFailed") });
          patch(key, { state: "ready", attachmentId: ticket.value.attachmentId });
          // A throw (the action unreachable, the client missing its config) must not leave the file
          // "uploading" forever: the form waits for every upload and would never send.
        })().catch(() => patch(key, { state: "error", error: t("uploadFailed") }));
      }
    },
    [t],
  );

  return {
    items,
    addFiles,
    remove: (key: string) => setItems((list) => list.filter((i) => i.key !== key)),
    reset: () => setItems([]),
    readyIds: items.flatMap((i) => (i.state === "ready" && i.attachmentId ? [i.attachmentId] : [])),
    uploading: items.some((i) => i.state === "uploading"),
  };
}

export function AttachmentPicker({ uploads }: { uploads: ReturnType<typeof useAttachmentUploads> }) {
  const t = useReportStrings();
  const input = useRef<HTMLInputElement>(null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    uploads.addFiles(e.dataTransfer.files);
  };
  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <button type="button" onClick={() => input.current?.click()}>
        {t("attachPick")}
      </button>{" "}
      {t("attachHint")}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={REPORT_LIMITS.allowedMime.join(",")}
        onChange={(e) => {
          if (e.target.files) uploads.addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <ul>
        {uploads.items.map((i) => (
          <li key={i.key} data-state={i.state} title={i.error}>
            {i.name} {i.error ?? `${Math.max(1, Math.round(i.size / 1024))} kB`}{" "}
            <button type="button" aria-label={t("remove")} onClick={() => uploads.remove(i.key)}>
              x
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Paste is the common case for a bug: a screenshot taken a moment ago. A pasted image has no file name, so it
gets one with the time in it. The form refuses to submit while an upload is still running, rather than
silently saving the report without the file.

The bucket is created by the migration in data-model.md, private, with no object policies: the browser
writes only through a signed upload token, and reads only through the route above.
