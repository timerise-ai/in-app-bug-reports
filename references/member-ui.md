# The member screens: form, list, thread, entry points

This file ships structure, state and behaviour, in bare HTML elements: the host's buttons, tabs, inputs,
cards and badges go in their place, and nothing here carries a class name to strip first.

| Screen | Route | Contents |
|---|---|---|
| List | `/bug-reports` | Open and Closed tabs; every report of the tenant, newest activity first; "Report a bug" |
| Form | `/bug-reports/new` | Title, markdown description with preview, attachments, privacy hint, context note |
| Thread | `/bug-reports/[id]` | The report, the comments in order, status, attachments, a comment box |

## Entry points

Reporting a bug is a rare act, not daily work, so the module does not need a place in the main navigation.
Members arrive from:

- a **"Report a bug" button on the help page**, and on every help article, passing the article's path:
  `/bug-reports/new?from=help&path=/help/<slug>`;
- a **"Your reports" link** on the help page, to the list;
- a **link in the assistant panel**, passing the current page: `/bug-reports/new?from=assistant&path=...`;
- the **assistant's draft card**, see assistant-tool.md;
- a **notification**, which opens the thread.

A host that wants a menu item adds one. The page works the same either way.

## Shared pieces

```typescript
// components/bug-reports/context.ts
import type { ReportContext } from "@/lib/bug-reports/types";

/**
 * Where the bug happened, as far as the browser can say. `path` is the page the member came from, not
 * the form, which tells the team nothing. The action validates the shape again.
 */
export function collectReportContext(path?: string): ReportContext {
  if (typeof window === "undefined") return {};
  let from = path;
  if (!from && document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.origin === window.location.origin) from = ref.pathname;
    } catch {
      // an unparsable referrer tells us nothing
    }
  }
  return {
    path: from?.slice(0, 300),
    userAgent: navigator.userAgent.slice(0, 400),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone?.slice(0, 60),
  };
}
```

```tsx
// components/bug-reports/MarkdownField.tsx
"use client";

import { useState, type ClipboardEvent, type ReactNode } from "react";
import { Markdown } from "./host-ui";
import { useReportStrings } from "./use-strings";

/**
 * A textarea with a Write and a Preview tab. The preview is the host's safe renderer (host-ui.tsx), so
 * what the member previews is exactly what the thread shows. Bare elements: swap in the host's tabs and
 * textarea, keep the behaviour.
 */
export function MarkdownField({
  value,
  onChange,
  maxLength,
  rows = 8,
  placeholder,
  footer,
  onPaste,
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  footer?: ReactNode;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const t = useReportStrings();
  const [tab, setTab] = useState<"write" | "preview">("write");
  return (
    <div>
      <div role="tablist">
        <button type="button" role="tab" aria-selected={tab === "write"} onClick={() => setTab("write")}>
          {t("write")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
          {t("preview")}
        </button>
      </div>
      {tab === "write" ? (
        <textarea rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onPaste={onPaste} />
      ) : (
        <div role="tabpanel">{value.trim() ? <Markdown source={value} /> : t("previewEmpty")}</div>
      )}
      <div>
        {footer}
        {maxLength != null && (
          <span aria-live="polite">
            {value.length}/{maxLength}
          </span>
        )}
      </div>
    </div>
  );
}
```

The preview is rendered by the host's renderer through `host-ui.tsx`, the same one the thread uses, so what
a member previews is exactly what the team's replies and the thread look like. A form with a preview built
from a different renderer than the page it posts to shows one thing and saves another.

## The form

```tsx
// components/bug-reports/ReportForm.tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { REPORT_DRAFT_STORAGE_KEY, REPORT_LIMITS, type ReportDraft, type ReportSource } from "@/lib/bug-reports/types";
import { createReport } from "@/app/bug-reports/actions";
import { AttachmentPicker, useAttachmentUploads } from "./AttachmentPicker";
import { collectReportContext } from "./context";
import { MarkdownField } from "./MarkdownField";
import { useReportStrings } from "./use-strings";

/**
 * "Report a bug". Prefilled from the query, or from the assistant's draft handed over in sessionStorage,
 * which a long markdown body needs: it does not fit a URL. `fromPath` is the page the member came from.
 */
export function ReportForm({
  source,
  initial,
  fromPath,
}: {
  source: ReportSource;
  initial: { title: string; body: string };
  fromPath?: string;
}) {
  const t = useReportStrings();
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [path, setPath] = useState(fromPath);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const uploads = useAttachmentUploads();

  useEffect(() => {
    if (source !== "assistant") return;
    try {
      const raw = sessionStorage.getItem(REPORT_DRAFT_STORAGE_KEY);
      if (!raw) return;
      sessionStorage.removeItem(REPORT_DRAFT_STORAGE_KEY);
      const draft = JSON.parse(raw) as ReportDraft;
      // One read of browser storage after hydration: the server render cannot see it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (typeof draft.title === "string") setTitle(draft.title.slice(0, REPORT_LIMITS.titleMax));
      if (typeof draft.body === "string") setBody(draft.body.slice(0, REPORT_LIMITS.bodyMax));
      if (typeof draft.path === "string") setPath(draft.path);
    } catch {
      // a private window or a mangled draft: the form starts empty
    }
  }, [source]);

  function submit() {
    setError(null);
    if (uploads.uploading) return setError(t("waitForUploads"));
    start(async () => {
      const result = await createReport({ title, body, attachmentIds: uploads.readyIds, source, context: collectReportContext(path) });
      if (!result.ok) return setError(t(`error.${result.error}`));
      router.push(`/bug-reports/${result.value.id}?sent=1`);
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p>{t("privacyHint")}</p>
      <label>
        {t("fieldTitle")}
        <input required value={title} maxLength={REPORT_LIMITS.titleMax} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <MarkdownField
        value={body}
        onChange={setBody}
        maxLength={REPORT_LIMITS.bodyMax}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            uploads.addFiles(files);
          }
        }}
        footer={<AttachmentPicker uploads={uploads} />}
      />
      <p>{t("contextNote")}</p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending || !title.trim()}>
        {t("send")}
      </button>
    </form>
  );
}
```

```tsx
// app/bug-reports/new/page.tsx
import { notFound } from "next/navigation";
import { REPORT_LIMITS, REPORT_SOURCES, type ReportSource } from "@/lib/bug-reports/types";
import { bugReportsHost } from "@/server/bug-reports/host";
import { ReportForm } from "@/components/bug-reports/ReportForm";

type Search = { title?: string; body?: string; from?: string; path?: string };

/** The form, opened before the report exists. `?from=help&path=/help/x` comes from a help page button. */
export default async function NewBugReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (!(await bugReportsHost.currentMember())) notFound();
  const sp = await searchParams;
  const source: ReportSource = (REPORT_SOURCES as readonly string[]).includes(sp.from ?? "") ? (sp.from as ReportSource) : "form";
  const path = sp.path?.startsWith("/") ? sp.path.slice(0, 300) : undefined;
  return (
    <main>
      <ReportForm
        source={source}
        initial={{ title: (sp.title ?? "").slice(0, REPORT_LIMITS.titleMax), body: (sp.body ?? "").slice(0, 4000) }}
        fromPath={path}
      />
    </main>
  );
}
```

The privacy hint is not decoration: the text goes to an engineering repository. It asks the member not to
type customer data and to cover it on screenshots.

The context note says what is attached automatically: the page the member came from, the browser, the
viewport and the time zone. The page is the referrer when the form was reached by a link, or the `path` the
entry point passed; the form itself is never the page reported.

## The list

```tsx
// app/bug-reports/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { consoleKeys } from "@/lib/bug-reports/strings";
import { bugReportsHost } from "@/server/bug-reports/host";
import { listReports } from "@/server/bug-reports/reports";

/**
 * The tenant's reports, every member's: a bug one person reported is the bug the next was about to.
 * Tabs and the page cursor live in the URL, so reload and back return to the same view.
 */
export default async function BugReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string; cursor?: string }> }) {
  const member = await bugReportsHost.currentMember();
  if (!member) notFound();
  const { tab, cursor } = await searchParams;
  const closed = tab === "closed";
  const page = await listReports(await bugReportsHost.sessionDb(), { closed, cursor });
  const t = consoleKeys;

  return (
    <main>
      <header>
        <h1>{t.title}</h1>
        <Link href="/bug-reports/new">{t.reportButton}</Link>
      </header>
      <nav>
        <Link href="/bug-reports" aria-current={closed ? undefined : "page"}>{t.tabOpen}</Link>
        <Link href="/bug-reports?tab=closed" aria-current={closed ? "page" : undefined}>{t.tabClosed}</Link>
      </nav>
      {page.items.length === 0 && <p>{closed ? t.emptyClosed : t.emptyOpen}</p>}
      <ul>
        {page.items.map((r) => (
          <li key={r.id}>
            <Link href={`/bug-reports/${r.id}`}>
              #{r.number} {r.title}
            </Link>{" "}
            <span data-status={r.status}>{t[`status.${r.status}`]}</span> {r.reporterName}
          </li>
        ))}
      </ul>
      {page.nextCursor && (
        <Link href={`/bug-reports?${new URLSearchParams({ ...(closed ? { tab: "closed" } : {}), cursor: page.nextCursor })}`}>
          {t.loadMore}
        </Link>
      )}
    </main>
  );
}
```

Every member sees every report of the tenant. A bug one person reported is the bug the next person was
about to report, and the list is where they find out.

## The thread

```tsx
// components/bug-reports/ReportThread.tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { REPORT_LIMITS } from "@/lib/bug-reports/types";
import type { ReportDetail } from "@/server/bug-reports/reports";
import { addComment, markReportRead } from "@/app/bug-reports/actions";
import { replyAsOperator, retrySync } from "@/app/operator/bug-reports/actions";
import { AttachmentPicker, useAttachmentUploads } from "./AttachmentPicker";
import { Markdown, formatDate, useBellRefresh } from "./host-ui";
import { MarkdownField } from "./MarkdownField";
import { useReportStrings } from "./use-strings";

/**
 * One report and its thread, for members (`mode="member"`) and operators (`mode="operator"`). They differ
 * in what they may know: only operators see tracker logins, the raw context, sync errors and comments the
 * tracker took back. Members read every team reply under the team's name.
 */
export function ReportThread({
  report,
  mode,
  justSent = false,
}: {
  report: ReportDetail;
  mode: "member" | "operator";
  justSent?: boolean;
}) {
  const t = useReportStrings();
  const router = useRouter();
  const operator = mode === "operator";
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const uploads = useAttachmentUploads();
  const lastComment = report.comments.at(-1)?.id;
  const onRead = useBellRefresh();

  // Reading the thread reads its notice. Re-run when the thread changes, as after a refresh with a reply.
  useEffect(() => {
    if (operator) return;
    void markReportRead(report.id).then((changed) => (changed > 0 ? onRead() : undefined)).catch(() => {});
  }, [operator, report.id, report.status, lastComment, onRead]);

  const files = (commentId: string | null) => report.attachments.filter((a) => a.commentId === commentId);
  const fileLinks = (commentId: string | null) => (
    <ul>
      {files(commentId).map((f) => (
        <li key={f.id}>
          <a href={`/api/bug-reports/attachments/${f.id}`} target="_blank" rel="noreferrer">
            {f.fileName}
          </a>
        </li>
      ))}
    </ul>
  );

  function send() {
    setError(null);
    if (uploads.uploading) return setError(t("waitForUploads"));
    start(async () => {
      const result = operator
        ? await replyAsOperator({ reportId: report.id, body })
        : await addComment({ reportId: report.id, body, attachmentIds: uploads.readyIds });
      if (!result.ok) return setError(t(`error.${result.error}`));
      setBody("");
      uploads.reset();
      router.refresh();
    });
  }

  return (
    <article>
      <header>
        <span>#{report.number}</span> <h1>{report.title}</h1> <span data-status={report.status}>{t(`status.${report.status}`)}</span>
        {operator && report.trackerUrl && (
          <a href={report.trackerUrl} target="_blank" rel="noreferrer">
            GitHub #{report.trackerNumber}
          </a>
        )}
      </header>
      {justSent && <p role="status">{t("sentNotice")}</p>}
      {report.syncState === "pending" && <p>{t("pendingNote")}</p>}
      {operator && (report.syncState === "failed" || report.syncError) && (
        <p role="alert">
          {report.syncError}{" "}
          <button type="button" onClick={() => start(async () => void (await retrySync(report.id), router.refresh()))}>
            {t("retry")}
          </button>
        </p>
      )}
      <section>
        <p>
          {report.reporterName}, {formatDate(report.createdAt)}
        </p>
        <Markdown source={report.bodyMd} />
        {fileLinks(null)}
        {operator && <pre>{JSON.stringify(report.context, null, 2)}</pre>}
      </section>
      {report.comments.map((c) => (
        <section key={c.id} data-author={c.authorKind} data-hidden={c.hidden || undefined}>
          <p>
            {c.authorKind === "member" ? c.authorName : t("teamName")}
            {operator && c.trackerLogin ? ` @${c.trackerLogin}` : ""}, {formatDate(c.createdAt)}
          </p>
          <Markdown source={c.bodyMd} />
          {fileLinks(c.id)}
        </section>
      ))}
      <section>
        <h2>{t("addComment")}</h2>
        {report.status !== "open" && !operator && <p>{t("closedCommentNote")}</p>}
        <MarkdownField
          value={body}
          onChange={setBody}
          rows={4}
          maxLength={REPORT_LIMITS.bodyMax}
          footer={operator ? undefined : <AttachmentPicker uploads={uploads} />}
        />
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={send} disabled={pending || !body.trim()}>
          {t("send")}
        </button>
      </section>
    </article>
  );
}
```

```tsx
// app/bug-reports/[id]/page.tsx
import { notFound } from "next/navigation";
import { bugReportsHost } from "@/server/bug-reports/host";
import { getReport } from "@/server/bug-reports/reports";
import { ReportThread } from "@/components/bug-reports/ReportThread";

/** One report. The session client reads it, so another tenant's id is simply not found. */
export default async function BugReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  if (!(await bugReportsHost.currentMember())) notFound();
  const [{ id }, { sent }] = await Promise.all([params, searchParams]);
  const report = await getReport(await bugReportsHost.sessionDb(), id, { includeHidden: false });
  if (!report) notFound();
  return (
    <main>
      <ReportThread report={report} mode="member" justSent={sent === "1"} />
    </main>
  );
}
```

- **Team replies carry the team's name**, never a GitHub login: members do not need the engineers'
  handles, and operators see them in their own view.
- **"Passing it to the team"** shows while the report is unsynced. A member never sees "failed": that is
  an operator's problem, shown on the operator view.
- **A closed report still takes comments**, with a note that the comment still reaches the team. "It is
  back" is the most useful comment a closed report gets.

States each screen must have: the list empty with a call to report, the list empty on the Closed tab (a
plain statement), the form with an upload still running (submit refused with a reason), the thread while
unsynced, and the thread after "sent" (a thank-you line from `?sent=1`).
