# Reads and writes: the read models and the Server Actions

## Read models

```typescript
// server/bug-reports/reports.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReportAttachment, ReportComment, ReportContext, ReportSource, ReportStatus, SyncState } from "@/lib/bug-reports/types";

/**
 * The read models. Tenant reads take the session client, so RLS scopes them to the tenant and hides the
 * comments the tracker took back; operator reads take the service client behind `currentOperator()`.
 * Lists page by keyset on (last_activity_at, id) and say when there is more, instead of stopping at a
 * cap the reader cannot see.
 */
export const PAGE_SIZE = 50;

export type ReportListItem = {
  id: string;
  tenantId: string;
  number: number;
  title: string;
  status: ReportStatus;
  reporterName: string;
  lastActivityAt: string;
  syncState: SyncState;
  trackerNumber: number | null;
  trackerUrl: string | null;
};

export type ReportPage = { items: ReportListItem[]; nextCursor: string | null };

export type ReportDetail = ReportListItem & {
  bodyMd: string;
  source: ReportSource;
  context: ReportContext;
  closedAt: string | null;
  createdAt: string;
  syncError: string | null;
  comments: ReportComment[];
  attachments: ReportAttachment[];
};

type Row = Record<string, unknown>;
const LIST = "id, tenant_id, number, title, status, reporter_name, last_activity_at, sync_state, tracker_number, tracker_url";

function toItem(r: Row): ReportListItem {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    number: r.number as number,
    title: r.title as string,
    status: r.status as ReportStatus,
    reporterName: r.reporter_name as string,
    lastActivityAt: r.last_activity_at as string,
    syncState: r.sync_state as SyncState,
    trackerNumber: (r.tracker_number as number | null) ?? null,
    trackerUrl: (r.tracker_url as string | null) ?? null,
  };
}

/** The cursor is `<last_activity_at>|<id>` of the last row shown. */
function parseCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  const [at, id] = (cursor ?? "").split("|");
  return at && id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}

export async function listReports(
  db: SupabaseClient,
  filter: { closed?: boolean; tenantId?: string; syncState?: SyncState; cursor?: string | null },
): Promise<ReportPage> {
  let q = db.from("bug_reports").select(LIST).order("last_activity_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE + 1);
  if (filter.closed !== undefined) q = filter.closed ? q.neq("status", "open") : q.eq("status", "open");
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  if (filter.syncState) q = q.eq("sync_state", filter.syncState);
  const c = parseCursor(filter.cursor);
  if (c) q = q.or(`last_activity_at.lt.${c.at},and(last_activity_at.eq.${c.at},id.lt.${c.id})`);
  const { data, error } = await q;
  if (error) throw new Error(`report list: ${error.message}`);
  const rows = (data ?? []) as Row[];
  const items = rows.slice(0, PAGE_SIZE).map(toItem);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > PAGE_SIZE && last ? `${last.lastActivityAt}|${last.id}` : null };
}

export async function getReport(db: SupabaseClient, id: string, opts: { includeHidden: boolean }): Promise<ReportDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data: r } = await db.from("bug_reports").select(`${LIST}, body_md, source, context, closed_at, created_at, sync_error`).eq("id", id).maybeSingle();
  if (!r) return null;
  let cq = db
    .from("bug_report_comments")
    .select("id, report_id, author_kind, author_name, tracker_login, body_md, created_at, edited_at, hidden_at")
    .eq("report_id", id)
    .order("created_at");
  if (!opts.includeHidden) cq = cq.is("hidden_at", null);
  const [{ data: comments }, { data: files }] = await Promise.all([
    cq,
    db.from("bug_report_attachments").select("id, report_id, comment_id, file_name, mime_type, size_bytes").eq("report_id", id).eq("status", "ready").order("created_at"),
  ]);
  return {
    ...toItem(r as Row),
    bodyMd: r.body_md as string,
    source: r.source as ReportSource,
    context: (r.context ?? {}) as ReportContext,
    closedAt: (r.closed_at as string | null) ?? null,
    createdAt: r.created_at as string,
    syncError: (r.sync_error as string | null) ?? null,
    comments: ((comments ?? []) as Row[]).map((c) => ({
      id: c.id as string,
      reportId: c.report_id as string,
      authorKind: c.author_kind as ReportComment["authorKind"],
      authorName: c.author_name as string,
      trackerLogin: (c.tracker_login as string | null) ?? null,
      bodyMd: c.body_md as string,
      createdAt: c.created_at as string,
      editedAt: (c.edited_at as string | null) ?? null,
      hidden: c.hidden_at != null,
    })),
    attachments: ((files ?? []) as Row[]).map((f) => ({
      id: f.id as string,
      reportId: f.report_id as string,
      commentId: (f.comment_id as string | null) ?? null,
      fileName: f.file_name as string,
      mimeType: f.mime_type as string,
      sizeBytes: f.size_bytes as number,
    })),
  };
}
```

Members read through the session client, so RLS scopes every read to their tenant and hides comments the
tracker took back. Operators read the same functions through the service client, behind
`currentOperator()`, with `includeHidden: true` so they see what was hidden and why.

Lists page by keyset on `(last_activity_at, id)`, fifty at a time, with a cursor in the URL. A list that
stopped at a fixed cap would quietly stop showing a tenant's older reports once they had enough of them,
and the reader would take "not in the list" for "never reported".

## Member actions

```typescript
// app/bug-reports/actions.ts
"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/bug-reports/action-result";
import { REPORT_LIMITS, REPORT_SOURCES, reportContextSchema, type ReportContext, type ReportSource } from "@/lib/bug-reports/types";
import { bugReportsHost } from "@/server/bug-reports/host";
import { claimAttachments, reserveUpload, type UploadTicket } from "@/server/bug-reports/attachments";
import { enqueueJob } from "@/server/bug-reports/jobs";
import { notifyFollowers } from "@/server/bug-reports/notify";
import { processDueJobs } from "@/server/bug-reports/worker";

/**
 * The member side. Every member may report and comment; the RLS policies admit exactly what these insert,
 * and nothing here can write a status: the tracker owns it.
 */
const uuid = z.string().uuid();

/** Try the outbox straight away; the cron is the safety net, not the path. */
function sendSoon(): void {
  after(async () => {
    try {
      await processDueJobs(5, { reconcile: false });
    } catch (err) {
      console.error("[bug-reports] immediate send failed", err);
    }
  });
}

export async function prepareUpload(input: { fileName: string; mimeType: string; size: number }): Promise<ActionResult<UploadTicket>> {
  const member = await bugReportsHost.currentMember();
  if (!member) return { ok: false, error: "not_found" };
  const parsed = z.object({ fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(100), size: z.number().positive() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const ticket = await reserveUpload(member, await bugReportsHost.sessionDb(), bugReportsHost.serviceDb(), parsed.data);
    return "refused" in ticket ? { ok: false, error: ticket.refused } : { ok: true, value: ticket };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "failed" };
  }
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(REPORT_LIMITS.titleMax),
  body: z.string().max(REPORT_LIMITS.bodyMax),
  attachmentIds: z.array(uuid).max(REPORT_LIMITS.maxFiles),
  source: z.enum(REPORT_SOURCES),
  context: reportContextSchema,
});

export async function createReport(input: {
  title: string;
  body: string;
  attachmentIds: string[];
  source: ReportSource;
  context: ReportContext;
}): Promise<ActionResult<{ id: string; number: number }>> {
  const member = await bugReportsHost.currentMember();
  if (!member) return { ok: false, error: "not_found" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { title, body, attachmentIds, source, context } = parsed.data;

  try {
    const session = await bugReportsHost.sessionDb();
    // Counted in the table, not in instance memory: durable across cold starts and instances.
    const { count } = await session
      .from("bug_reports")
      .select("id", { count: "exact", head: true })
      .eq("reporter_id", member.id)
      .gte("created_at", new Date(Date.now() - 3600_000).toISOString());
    if ((count ?? 0) >= REPORT_LIMITS.reportsPerHour) return { ok: false, error: "rate_limited" };

    const { data, error } = await session
      .from("bug_reports")
      .insert({
        tenant_id: member.tenantId,
        reporter_id: member.id,
        reporter_name: member.name,
        reporter_role: member.roleLabel,
        title,
        body_md: body,
        source,
        context,
      })
      .select("id, number")
      .single();
    if (error || !data) throw new Error(`report insert: ${error?.message}`);

    const service = bugReportsHost.serviceDb();
    await claimAttachments(service, member, attachmentIds, { reportId: data.id as string });
    await enqueueJob(service, { tenantId: member.tenantId, reportId: data.id as string, kind: "create_issue" });
    await bugReportsHost.audit({ tenantId: member.tenantId, actor: member.id, action: "bug_report.create", reportId: data.id as string, data: { source } });
    sendSoon();
    revalidatePath("/bug-reports");
    return { ok: true, value: { id: data.id as string, number: data.number as number } };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "failed" };
  }
}

const commentSchema = z.object({
  reportId: uuid,
  body: z.string().trim().min(1).max(REPORT_LIMITS.bodyMax),
  attachmentIds: z.array(uuid).max(REPORT_LIMITS.maxFiles),
});

export async function addComment(input: { reportId: string; body: string; attachmentIds: string[] }): Promise<ActionResult<{ id: string }>> {
  const member = await bugReportsHost.currentMember();
  if (!member) return { ok: false, error: "not_found" };
  const parsed = commentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { reportId, body, attachmentIds } = parsed.data;

  const session = await bugReportsHost.sessionDb();
  const { data, error } = await session
    .from("bug_report_comments")
    .insert({ tenant_id: member.tenantId, report_id: reportId, author_kind: "member", author_member_id: member.id, author_name: member.name, body_md: body })
    .select("id")
    .single();
  // The policy refuses another tenant's report id: that reads as "not found", not "forbidden".
  if (error || !data) return { ok: false, error: "not_found" };

  try {
    const service = bugReportsHost.serviceDb();
    await claimAttachments(service, member, attachmentIds, { reportId, commentId: data.id as string });
    await service.from("bug_reports").update({ last_activity_at: new Date().toISOString() }).eq("id", reportId).eq("tenant_id", member.tenantId);
    await enqueueJob(service, { tenantId: member.tenantId, reportId, kind: "post_comment", commentId: data.id as string });
    const { data: report } = await service.from("bug_reports").select("id, number, title, reporter_id").eq("id", reportId).maybeSingle();
    if (report) {
      await notifyFollowers(
        service,
        { id: report.id as string, number: report.number as number, title: report.title as string, reporter_id: (report.reporter_id as string | null) ?? null },
        { kind: "comment", authorName: member.name, body },
        { exclude: member.id },
      );
    }
    sendSoon();
    revalidatePath(`/bug-reports/${reportId}`);
    return { ok: true, value: { id: data.id as string } };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "failed" };
  }
}

/** Opening a report reads its notice. Returns how many changed, so the bell refreshes only when needed. */
export async function markReportRead(reportId: string): Promise<number> {
  const member = await bugReportsHost.currentMember();
  if (!member || !uuid.safeParse(reportId).success) return 0;
  return bugReportsHost.markNoticesRead(member.id, reportId);
}
```

- **No role check.** Every member may report and comment: the person who hits a bug is rarely the person
  with an admin role. The host's permission system is not consulted, and the RLS admits any member.
- **Ten reports an hour per member**, counted in the table. Durable across instances and cold starts, where
  an in-memory counter is not.
- **Errors are codes.** A thrown message is replaced by a generic one in production builds; a returned
  code reaches the form, and the host's catalogue says it in the member's language.
- **The comment insert runs as the member**, so the policy refuses another tenant's report id. That answer
  is "not found", never "forbidden".
- **`markReportRead`** is called by the thread when it opens; see notifications.md.

## Operator actions

```typescript
// app/operator/bug-reports/actions.ts
"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/bug-reports/action-result";
import { REPORT_LIMITS } from "@/lib/bug-reports/types";
import { bugReportsHost } from "@/server/bug-reports/host";
import { enqueueJob } from "@/server/bug-reports/jobs";
import { notifyFollowers } from "@/server/bug-reports/notify";
import { processDueJobs } from "@/server/bug-reports/worker";

/**
 * The operator side, across tenants on the service client, so `currentOperator()` is the only check and
 * comes first. No close or reopen: closing the issue on the tracker is how an operator resolves a report.
 */
function sendSoon(): void {
  after(async () => {
    try {
      await processDueJobs(5, { reconcile: false });
    } catch (err) {
      console.error("[bug-reports] immediate send failed", err);
    }
  });
}

export async function replyAsOperator(input: { reportId: string; body: string }): Promise<ActionResult<{ id: string }>> {
  const operator = await bugReportsHost.currentOperator();
  if (!operator) return { ok: false, error: "not_found" };
  const parsed = z.object({ reportId: z.string().uuid(), body: z.string().trim().min(1).max(REPORT_LIMITS.bodyMax) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const db = bugReportsHost.serviceDb();
  const { data: report } = await db.from("bug_reports").select("id, tenant_id, number, title, reporter_id").eq("id", parsed.data.reportId).maybeSingle();
  if (!report) return { ok: false, error: "not_found" };

  const { data, error } = await db
    .from("bug_report_comments")
    .insert({ tenant_id: report.tenant_id, report_id: report.id, author_kind: "operator", author_name: "team", body_md: parsed.data.body })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "failed" };
  await db.from("bug_reports").update({ last_activity_at: new Date().toISOString() }).eq("id", report.id);
  await enqueueJob(db, { tenantId: report.tenant_id as string, reportId: report.id as string, kind: "post_comment", commentId: data.id as string });
  await bugReportsHost.audit({ tenantId: report.tenant_id as string, actor: operator.userId, action: "bug_report.reply", reportId: report.id as string, data: { comment: data.id } });
  await notifyFollowers(
    db,
    { id: report.id as string, number: report.number as number, title: report.title as string, reporter_id: (report.reporter_id as string | null) ?? null },
    { kind: "reply", body: parsed.data.body },
  );
  sendSoon();
  revalidatePath(`/operator/bug-reports/${report.id as string}`);
  return { ok: true, value: { id: data.id as string } };
}

/** Put a report whose tracker side failed back in the outbox, with its failed comments. */
export async function retrySync(reportId: string): Promise<ActionResult<null>> {
  const operator = await bugReportsHost.currentOperator();
  if (!operator || !z.string().uuid().safeParse(reportId).success) return { ok: false, error: "not_found" };
  const db = bugReportsHost.serviceDb();
  const { data: report } = await db.from("bug_reports").select("id, tenant_id, tracker_number").eq("id", reportId).maybeSingle();
  if (!report) return { ok: false, error: "not_found" };
  const tenantId = report.tenant_id as string;

  if (!report.tracker_number) await enqueueJob(db, { tenantId, reportId, kind: "create_issue" });
  const { data: failed } = await db.from("bug_report_comments").select("id").eq("report_id", reportId).eq("sync_state", "failed");
  for (const c of failed ?? []) {
    await db.from("bug_report_comments").update({ sync_state: "pending" }).eq("id", c.id);
    await enqueueJob(db, { tenantId, reportId, kind: "post_comment", commentId: c.id as string });
  }
  await db.from("bug_reports").update({ sync_state: report.tracker_number ? "synced" : "pending", sync_error: null }).eq("id", reportId);
  await bugReportsHost.audit({ tenantId, actor: operator.userId, action: "bug_report.retry", reportId, data: {} });
  sendSoon();
  revalidatePath(`/operator/bug-reports/${reportId}`);
  return { ok: true, value: null };
}
```

No close and no reopen, for operators either. Closing the issue on GitHub is how an operator resolves a
report, and the webhook brings it back. Two writers of one field is how the app and the tracker come to
disagree.

`retrySync` re-queues a report whose issue job was parked and every comment whose job was parked. It is the
operator's answer to a failure the outbox gave up on, after fixing its cause: a revoked installation, a
renamed repository, a rotated key.
