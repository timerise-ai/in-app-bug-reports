# Notifications: who hears about a report, and when

| Event | Who is told | Not told |
|---|---|---|
| Status changes on the tracker | The reporter and every member who commented | Nobody excluded: the tracker did it |
| A team reply (`/reply` on GitHub, or an operator in the app) | The reporter and every commenter | |
| A member's comment | The reporter and the other commenters | The comment's author |

One notice per report: the tag is `bug-report:<id>`, and the host's feed replaces a member's earlier row
with the same tag. Ten replies in an afternoon are one line in the bell, the newest, and the title of each
must therefore stand on its own: "The team replied to report #12", not "New reply".

## Copy and recipients

```typescript
// lib/bug-reports/notification-copy.ts
import { NOTICE_STRINGS } from "./strings";

/**
 * What the bell says about a report. One row per report (the tag is `bug-report:<id>`), so a later event
 * replaces the earlier one and each title must stand alone.
 */
export type ReportEvent =
  | { kind: "status"; status: string }
  | { kind: "reply"; body?: string }
  | { kind: "comment"; authorName: string; body?: string };

const EXCERPT_MAX = 140;

/** Plain text on one line, cut on a word. Markdown emphasis, code and link syntax are dropped. */
export function excerpt(md: string | undefined, max = EXCERPT_MAX): string {
  const text = (md ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export function reportNotice(
  report: { number: number; title: string },
  event: ReportEvent,
): { title: string; body: string } {
  const ref = `#${report.number}`;
  const s = NOTICE_STRINGS;
  switch (event.kind) {
    case "status":
      return { title: s.statusTitle(ref, s.status[event.status] ?? s.statusFallback), body: report.title };
    case "reply":
      return { title: s.replyTitle(ref), body: excerpt(event.body) || report.title };
    case "comment":
      return { title: s.commentTitle(event.authorName, ref), body: excerpt(event.body) || report.title };
  }
}

/** The people who follow a report: whoever filed it and every member who commented, minus the actor. */
export function noticeRecipients(
  reporterId: string | null,
  commenterIds: readonly (string | null)[],
  exclude: string | null,
): string[] {
  const ids = [reporterId, ...commenterIds].filter((id): id is string => !!id && id !== exclude);
  return [...new Set(ids)];
}
```

The body quotes the reply or comment, flattened to one line and cut on a word, or falls back to the
report's title. A status notice carries the title, because "Report #12 resolved" alone does not say which
bug.

## Sending

```typescript
// server/bug-reports/notify.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { noticeRecipients, reportNotice, type ReportEvent } from "@/lib/bug-reports/notification-copy";
import { bugReportsHost } from "./host";

export type NoticeReport = { id: string; number: number; title: string; reporter_id: string | null };

/**
 * Tell the people following a report: whoever filed it and every member who commented, never the
 * person who caused the event. Best-effort: a failed notice never fails the webhook or the comment
 * that carried the news.
 */
export async function notifyFollowers(
  db: SupabaseClient,
  report: NoticeReport,
  event: ReportEvent,
  opts: { exclude?: string | null } = {},
): Promise<void> {
  try {
    const { data } = await db
      .from("bug_report_comments")
      .select("author_member_id")
      .eq("report_id", report.id)
      .eq("author_kind", "member");
    const commenters = (data ?? []).map((r) => (r.author_member_id as string | null) ?? null);
    const recipients = noticeRecipients(report.reporter_id, commenters, opts.exclude ?? null);
    if (recipients.length === 0) return;
    const copy = reportNotice(report, event);
    await bugReportsHost.notifyMembers(recipients, {
      title: copy.title,
      body: copy.body,
      url: `/bug-reports/${report.id}`,
      tag: `bug-report:${report.id}`,
      reportId: report.id,
    });
  } catch (err) {
    console.error("[bug-reports] notify failed", err);
  }
}
```

Best-effort, always. A notice that fails is logged and dropped; it never fails the webhook delivery or the
comment that carried the news, because a webhook that fails is redelivered and would notify twice.

## Reading

Opening the thread calls `markReportRead`, which calls the host's `markNoticesRead(memberId, reportId)`, and
the thread asks the host to refresh its badge (`useBellRefresh` in `host-ui.tsx`) when something changed.
The notice is read because the report was, without a trip to the drawer. It runs again when the thread
changes, so a reply that arrives while the member is looking at the thread is read too.

## The host's feed

`notifyMembers` receives the member ids and `{ title, body, url, tag, reportId }`. A host feed that keys
rows by member and tag, and that keeps `reportId` as the row's subject, can implement both methods in a few
lines. A host with push sends one per member on the same topic; members who muted it still get the feed
row. A host with no feed at all implements both as no-ops and loses nothing but the bell: the thread still
shows every reply.
