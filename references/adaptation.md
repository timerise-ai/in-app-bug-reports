# Adaptation: the seam contract with the host app

The module touches its host in the places listed here and nowhere else. Fill in the right-hand column
before writing a file: a seam that is not named gets hardcoded.

## The seam contract

| Seam | The skill ships | The host supplies |
|---|---|---|
| Domain entities | `Report`, `ReportComment`, `ReportAttachment`, member, operator, tenant, and the rename table below | Its own vocabulary |
| Tenant scope | One `tenant_id` on every row, read from the session, never from input | Organisation, workspace, account, team, site |
| Member | `currentMember()` returning `Member` | Its session lookup and its members table |
| Operator | `currentOperator()` returning `Operator` | Its staff allowlist: an e-mail list, a role, an admin table |
| Database | Postgres with Supabase RLS, two clients from `sessionDb()` and `serviceDb()` | The same, or a port, see *Other backends* |
| RLS helpers | Policies that call `app.current_tenant_id()` and `app.current_member_id()` | Those two SQL functions, below |
| Object storage | A private bucket with signed uploads and signed reads | Supabase Storage, or S3 or Blob with presigned URLs |
| Tracker | `IssueTracker` with a GitHub implementation | A GitHub App; another tracker is an implementation of the same interface |
| Notifications | `notifyMembers()` and `markNoticesRead()` | Its notification feed and push, or a no-op |
| Audit | `audit()` with `bug_report.*` actions | Its audit log, or a log line |
| Sign-in | `loginUrl(returnTo)` | Its sign-in route and the return parameter it honours |
| Proxy | `CRON_PATHS` and the bypass in outbox.md | Its `proxy.ts` or `middleware.ts` |
| Operator host | `OPERATOR_ORIGIN` | A host its proxy serves without resolving a tenant |
| Assistant | `draftBugReportTool` and `ReportDraftCard` | Its chat route and message renderer, if it has an assistant |
| Markdown | `Markdown` in `host-ui.tsx`, plain text by default | Its safe renderer: no raw HTML, safe link schemes |
| UI primitives | Bare elements with structure, states and roles | Its buttons, tabs, inputs, cards, badges and toasts |
| Styling | Nothing | Its design system |
| Strings | `consoleKeys`, `TRACKER_STRINGS`, `NOTICE_STRINGS` | Its i18n catalogue, in every locale |
| Background work | One worker every five minutes | Vercel Cron, or any scheduler that can send a bearer |
| Tests | Nine suites on the pure logic | Its runner |

## The host object

Every server module reaches the host through this object. The demo bodies answer `null` for both
identity checks, so until they are wired every route answers 404 rather than serving anyone.

```typescript
// server/bug-reports/host.ts
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The one file the host app fills in. Everything in `server/bug-reports/` reaches the host through this
 * object and nothing else: who is signed in, the two database clients, the tenant's display name, the
 * notification feed, the audit log and the login route. See references/adaptation.md.
 */

/** A signed-in person who belongs to a tenant. Every member may report; there is no role check. */
export type Member = { id: string; tenantId: string; name: string; roleLabel: string | null };

/** A person on the product team who sees every tenant's reports. Not a member of any tenant. */
export type Operator = { userId: string; email: string };

export type MemberNotice = { title: string; body: string; url: string; tag: string; reportId: string };

export type AuditEntry = {
  tenantId: string;
  /** The member or operator user id; null for the worker and the webhook. */
  actor: string | null;
  action: `bug_report.${string}`;
  reportId: string;
  data: Record<string, unknown>;
};

export interface BugReportsHost {
  /** The signed-in member, or null. Never redirects: routes decide what null means. */
  currentMember(): Promise<Member | null>;
  /** The signed-in operator, or null. */
  currentOperator(): Promise<Operator | null>;
  /** A client acting as the signed-in user: the RLS policies apply. */
  sessionDb(): Promise<SupabaseClient>;
  /** A client that bypasses RLS. Server only, and only after one of the checks above. */
  serviceDb(): SupabaseClient;
  tenantLabel(tenantId: string): Promise<{ name: string; slug: string | null }>;
  /** One feed row per member and tag (a newer row replaces the older), plus a push if the host has one. */
  notifyMembers(memberIds: readonly string[], notice: MemberNotice): Promise<void>;
  /** Mark the member's unread notices about this report read; returns how many changed. */
  markNoticesRead(memberId: string, reportId: string): Promise<number>;
  audit(entry: AuditEntry): Promise<void>;
  /** The sign-in URL that comes back to `returnTo` afterwards. */
  loginUrl(returnTo: string): string;
}

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("bug reports: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function unwired(name: string): never {
  throw new Error(`bugReportsHost.${name} is not wired to the host app yet (server/bug-reports/host.ts)`);
}

/**
 * The demo bodies. `currentMember` and `currentOperator` answer null until wired, so every route answers
 * 404 rather than serving anyone; the rest throw with the name of the method to fill in.
 */
export const bugReportsHost: BugReportsHost = {
  async currentMember() {
    return null;
  },
  async currentOperator() {
    return null;
  },
  async sessionDb() {
    return unwired("sessionDb");
  },
  serviceDb: serviceClient,
  async tenantLabel(tenantId) {
    const { data } = await serviceClient().from("tenants").select("name, slug").eq("id", tenantId).maybeSingle();
    return { name: (data?.name as string | undefined) ?? "Tenant", slug: (data?.slug as string | undefined) ?? null };
  },
  async notifyMembers() {
    return unwired("notifyMembers");
  },
  async markNoticesRead() {
    return 0;
  },
  async audit(entry) {
    console.info("[bug-reports] audit", entry.action, entry.reportId);
  },
  loginUrl(returnTo) {
    return `/login?next=${encodeURIComponent(returnTo)}`;
  },
};
```

A typical wiring, for a host whose members live in `members (id, tenant_id, user_id, name, role)` and
whose staff are an e-mail allowlist, replaces the first two bodies with its session lookup:
`currentMember` reads the signed-in user, selects that user's member row through the session client and
maps it to `Member`; `currentOperator` checks the user's e-mail against the allowlist through the service
client. Neither redirects: pages turn null into `notFound()`, actions into `{ ok: false }`.

While both answer null and read no cookie, `next build` prerenders the member and operator pages as static
404s. That is expected: they become dynamic as soon as `currentMember` reads the session. Do not add
`export const dynamic` to the pages to change it.

## The two SQL functions

The policies in data-model.md call these. They are the host's, because only the host knows how a signed-in
user maps to a member. For a members table keyed by `auth.uid()`:

```sql
-- supabase/migrations/<timestamp>_app_member_functions.sql
create schema if not exists app;

create or replace function app.current_tenant_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id from public.members m where m.user_id = auth.uid()
$$;

create or replace function app.current_member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.members m where m.user_id = auth.uid()
$$;

grant usage on schema app to authenticated;
grant execute on function app.current_tenant_id(), app.current_member_id() to authenticated;
```

`security definer` is deliberate here: the functions read `members`, which the caller may not be allowed
to select. `search_path = ''` and schema-qualified names keep that safe. A host that already has such
functions, under any name, uses its own and renames the calls in the migration.

## The strings

Three groups, three readers. `TRACKER_STRINGS` is read by the engineering team on GitHub, so it stays in
the repository's language, English by default, whatever language the tenants speak. `NOTICE_STRINGS` and
`consoleKeys` are read by members: a host with i18n moves them into its catalogue under the `bugReports`
namespace, in every locale, and replaces the body of `useReportStrings` with its own hook.

```typescript
// lib/bug-reports/strings.ts

/**
 * What the module writes on the tracker. English by default: it is read by the engineering team, in
 * the language their repository is in, which is rarely the tenant's. Change the values, never the keys.
 * The console's own copy lives in the host's i18n catalogue, under the keys in `consoleKeys` below.
 */
export const TRACKER_STRINGS = {
  noDescription: "_(no description)_",
  truncated: "_(truncated: the full text is in the app)_",
  rowTenant: "Tenant",
  rowReport: "Report",
  rowReporter: "Reported by",
  rowSource: "Source",
  rowPage: "Page",
  rowBrowser: "Browser",
  rowViewport: "Viewport",
  rowTimeZone: "Time zone",
  rowVersion: "App version",
  rowCreated: "Created",
  attachmentsHeading: "**Attachments** (sign-in required):",
  openInApp: "Open in the operator console",
  operatorAuthor: "Operator",
} as const;

/** What the bell and the push say. In the members' language: override from the host's catalogue. */
export const NOTICE_STRINGS = {
  statusTitle: (ref: string, phrase: string) => `Report ${ref} ${phrase}`,
  status: {
    open: "reopened",
    resolved: "resolved",
    not_planned: "closed: not planned",
    duplicate: "closed as a duplicate",
  } as Record<string, string>,
  statusFallback: "changed status",
  replyTitle: (ref: string) => `The team replied to report ${ref}`,
  commentTitle: (name: string, ref: string) => `${name} commented on report ${ref}`,
} as const;

/**
 * Console copy keys, for the host's i18n catalogue (namespace `bugReports`). The English values are the
 * defaults; a host with no i18n uses them as literals from one constants block.
 */
export const consoleKeys = {
  title: "Bug reports",
  reportButton: "Report a bug",
  myReports: "Your reports",
  newTitle: "New report",
  tabOpen: "Open",
  tabClosed: "Closed",
  emptyOpen: "No open reports. Something not working? Report it and the team's answer shows up here.",
  emptyClosed: "No closed reports yet.",
  fieldTitle: "Title",
  fieldBody: "Description",
  write: "Write",
  preview: "Preview",
  previewEmpty: "Nothing to preview.",
  privacyHint:
    "This report goes to the product team. Do not enter customer data, and cover it on screenshots.",
  contextNote: "We attach the page you came from, your browser and screen size.",
  attachPick: "Add files",
  attachHint: "or drop or paste them here.",
  fileType: "This file type cannot be attached",
  fileTooLarge: "Larger than {mb} MB",
  tooManyFiles: "At most {max} files",
  uploadFailed: "Upload failed",
  waitForUploads: "Wait for the files to finish uploading.",
  sentNotice: "Thank you. The team has your report; you will be notified when they reply.",
  pendingNote: "Passing it to the team...",
  addComment: "Add a comment",
  closedCommentNote: "This report is closed; a comment still reaches the team.",
  send: "Send",
  teamName: "Product team",
  draftHeading: "Draft report",
  draftSend: "Send report",
  draftEdit: "Edit in form",
  draftSent: "Sent as report #{number}.",
  showingNewest: "Showing the newest {count}.",
  loadMore: "Load more",
  "status.open": "Open",
  "status.resolved": "Resolved",
  "status.not_planned": "Not planned",
  "status.duplicate": "Duplicate",
  "error.invalid": "Check the fields and try again.",
  "error.not_found": "This report does not exist or is not yours to see.",
  "error.rate_limited": "Many reports in the last hour: try again later.",
  "error.type": "This file type cannot be attached.",
  "error.size": "The file is too large.",
  "error.empty": "The file is empty.",
  "error.failed": "Something went wrong. Try again.",
  retry: "Retry",
  remove: "Remove",
} as const;
export type ConsoleKey = keyof typeof consoleKeys;
```

```typescript
// components/bug-reports/use-strings.ts
"use client";

import { consoleKeys, type ConsoleKey } from "@/lib/bug-reports/strings";

/**
 * The strings seam for every component here. The default reads the English values and fills `{name}`
 * placeholders. A host with i18n replaces the body with its own hook, for example
 * `const t = useTranslations("bugReports"); return (key, vars) => t(key, vars);`, and adds the keys to
 * every locale it has.
 */
export type ReportT = (key: ConsoleKey, vars?: Record<string, string | number>) => string;

export function useReportStrings(): ReportT {
  return (key, vars) =>
    Object.entries(vars ?? {}).reduce<string>((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), consoleKeys[key]);
}
```

## The client UI seam

Server pages cannot pass functions to client components, so the three UI hooks the components need live
in one client module the host rewrites.

```tsx
// components/bug-reports/host-ui.tsx
"use client";

/**
 * The client half of the seam: three things every component here needs from the host's UI. Server pages
 * cannot hand functions to client components, so they live in a module the components import. The
 * defaults are safe and plain; replace each body with the host's own.
 */

/**
 * The host's markdown renderer. It must not render raw HTML and must limit links to http, https and
 * in-app paths, because the text comes from members and from the tracker. The default shows the text as
 * typed, which is safe and readable.
 */
export function Markdown({ source }: { source: string }) {
  return <div style={{ whiteSpace: "pre-wrap" }}>{source}</div>;
}

/** The host's date formatter, in the tenant's time zone. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** Refresh the host's notification badge after a report's notices were marked read. */
export function useBellRefresh(): () => void {
  return () => {};
}
```

The renderer the host plugs in must escape raw HTML and limit links to `http`, `https` and in-app paths.
Report text comes from members and replies come from the tracker; both are untrusted.

## Probe the host first

```bash
cat package.json                       # Next.js major, @supabase/*, zod, ai, i18n, test runner
cat CLAUDE.md AGENTS.md 2>/dev/null    # the house rules, stated
ls proxy.ts middleware.ts src/proxy.ts src/middleware.ts 2>/dev/null
cat vercel.json vercel.ts 2>/dev/null  # existing crons
```

Then read two existing feature slices end to end and note: the guard at the top of a protected route, how
an action reports a refusal, how a list pages, which component confirms a destructive action, where the
notification feed is written, and how the proxy decides which host serves what. The module follows those
conventions even where its templates do something else.

The module needs `zod`, `@supabase/supabase-js`, `@supabase/ssr` for the browser upload, `server-only`,
`vitest` for the suites, and `ai` only for the assistant tool. Install the ones the host lacks with its
package manager: the package registry is not an external service, and a note that none is reachable means
GitHub and Supabase, not npm. Add nothing beyond these, and never replace one with hand-written code; the
templates are typed against them, and a substitute means editing every template that imports it.

## The domain rename

Decide the vocabulary once, before the first file, and apply it everywhere at once.

| Canonical | Typical host words | Renamed in |
|---|---|---|
| tenant, `tenant_id`, `tenantId` | organisation, workspace, account, team | tables, types, policies, strings |
| member, `Member`, `reporter_id` | user, employee, staff | types, host object, columns |
| operator, `Operator`, `/operator` | admin, staff, platform team | host object, routes, strings |
| report, `bug_reports`, `/bug-reports` | feedback, ticket, issue report | tables, routes, components, strings |

Not renamed: GitHub's own terms (`state_reason`, `author_association`, `installation`, the event names),
the env names, the marker text (`bug-report:`), which existing issues already carry, and the
`IssueTracker` methods.

## Other backends

The Postgres store is the reference. A host on another stack ports it on these rules:

| Concern | Postgres and Supabase | Elsewhere |
|---|---|---|
| Tenant isolation | RLS policies in data-model.md | The same checks in every query of `reports.ts` and the actions; there is no database backstop, so test them |
| Insert-only for members | No UPDATE policy, privileges revoked | No update path in the member actions; status writes only in `webhook.ts` and `worker.ts` |
| Per-tenant number | Trigger with an advisory lock | A transaction that locks the tenant row, or a counter row per tenant |
| Outbox claim | `claim_bug_report_jobs` with `skip locked` | `UPDATE ... RETURNING` with a lease, or a queue with visibility timeouts |
| Ledger | Primary key on the delivery id | Any unique constraint; a conflict is a replay |
| Files | Private bucket, signed upload and read | S3 presigned PUT and GET, or a private Blob store with signed URLs |

## Non-negotiables

The five hard rules in `SKILL.md`, restated because they decide the seams: the app never writes a status,
a tracker comment reaches a tenant only through `/reply` from the team, the tracker is never called in the
request that saves a report, an attachment is never public, and the assistant never sends. A seam that
would break one of them is the wrong seam.
