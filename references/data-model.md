# Data model: reports, comments, attachments, outbox

Five tables and one bucket. Members insert reports, comments and attachment reservations; nothing a member
does can update or delete a row. Every later change, status included, is written by the service role from
the worker or the webhook.

| Table | Rows | Members may |
|---|---|---|
| `bug_reports` | One per report, numbered per tenant | Select their tenant's; insert as themselves, open and unsynced |
| `bug_report_comments` | Both directions: member, operator, tracker | Select their tenant's visible ones; insert as themselves on their tenant's report |
| `bug_report_attachments` | One per file, reserved before upload | Select their tenant's; insert a reservation in their tenant's folder |
| `bug_report_jobs` | The outbox to the tracker | Nothing |
| `bug_report_deliveries` | The webhook ledger, one row per delivery id | Nothing |
| `bug_report_bridge` | One row: the bridge's pulse and the reconcile cursor | Nothing |

## Types

```typescript
// lib/bug-reports/types.ts
import { z } from "zod";

/** Mirrors the `bug_reports_status` check. The tracker decides it; the app never writes it from a form. */
export const REPORT_STATUSES = ["open", "resolved", "not_planned", "duplicate"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Where the report was started: the form, the assistant's draft card, or a help page button. */
export const REPORT_SOURCES = ["form", "assistant", "help"] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

/** How far the report has travelled to the tracker. `detached`: the issue was deleted or transferred. */
export type SyncState = "pending" | "synced" | "failed" | "detached";

/** Who wrote a comment: a member in the app, an operator in the app, or the team on the tracker. */
export type CommentAuthorKind = "member" | "operator" | "tracker";

export type Report = {
  id: string;
  tenantId: string;
  number: number;
  reporterId: string | null;
  reporterName: string;
  reporterRole: string | null;
  title: string;
  bodyMd: string;
  source: ReportSource;
  context: ReportContext;
  status: ReportStatus;
  closedAt: string | null;
  trackerRepo: string | null;
  trackerNumber: number | null;
  trackerUrl: string | null;
  syncState: SyncState;
  syncError: string | null;
  lastActivityAt: string;
  createdAt: string;
};

export type ReportComment = {
  id: string;
  reportId: string;
  authorKind: CommentAuthorKind;
  authorName: string;
  /** Operators only: who wrote it on the tracker. */
  trackerLogin: string | null;
  bodyMd: string;
  createdAt: string;
  editedAt: string | null;
  hidden: boolean;
};

export type ReportAttachment = {
  id: string;
  reportId: string;
  commentId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export function isClosed(status: ReportStatus): boolean {
  return status !== "open";
}

/**
 * Upload limits. The bucket repeats the per-file cap and the type list, so a request that skips the
 * action still bounces. SVG and HTML are absent on purpose: opened from a signed URL, they execute.
 */
export const REPORT_LIMITS = {
  maxFiles: 10,
  maxBytes: 25 * 1024 * 1024,
  imageMaxBytes: 10 * 1024 * 1024,
  titleMax: 200,
  bodyMax: 20_000,
  reportsPerHour: 10,
  allowedMime: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
    "video/mp4",
    "video/webm",
  ],
} as const;

export function isAllowedMime(mime: string): boolean {
  return (REPORT_LIMITS.allowedMime as readonly string[]).includes(mime);
}

export function maxBytesFor(mime: string): number {
  return mime.startsWith("image/") ? REPORT_LIMITS.imageMaxBytes : REPORT_LIMITS.maxBytes;
}

/**
 * What the browser says about where the bug happened. Strict and bounded: it lands in an issue body
 * that people outside the tenant read, so nothing open-ended gets through.
 */
export const reportContextSchema = z
  .object({
    path: z.string().max(300).optional(),
    userAgent: z.string().max(400).optional(),
    viewport: z.string().max(20).optional(),
    timeZone: z.string().max(60).optional(),
  })
  .strict();
export type ReportContext = z.infer<typeof reportContextSchema>;

/** sessionStorage key the assistant's "Edit in form" hands a draft over in; a URL is too short for it. */
export const REPORT_DRAFT_STORAGE_KEY = "bug-report-draft";

export type ReportDraft = { title: string; body: string; path?: string };
```

Two names for one state, on purpose: `status` is the tenant's answer (is it fixed), `syncState` is the
bridge's (did it reach the tracker). A report can be `open` and `failed`, and an operator needs to see
both. Keeping them in one column is how a sync failure ends up shown to a member as "closed".

`reporterName` and `reporterRole` are snapshots taken at insert. They outlive the member row and are what
the tracker is told; the issue body never changes because someone was renamed.

## Action results

```typescript
// lib/bug-reports/action-result.ts

/**
 * What a Server Action hands back. Refusals are values, not throws: a thrown message is replaced by a
 * generic error in production builds, and the form could not say why it stopped. The code is a key the
 * host maps to its own copy.
 */
export type ActionErrorCode = "invalid" | "not_found" | "rate_limited" | "type" | "size" | "empty" | "failed";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionErrorCode };
```

## The migration

```sql
-- supabase/migrations/<timestamp>_bug_reports.sql
-- Bug reports from tenant members, bridged to an issue tracker. Members insert; nobody but the service
-- role updates: the tracker owns the status. Needs from the host: public.tenants(id), and the two
-- functions app.current_tenant_id() and app.current_member_id() (see references/adaptation.md).

-- 1) Reports ------------------------------------------------------------------------------------------
create table public.bug_reports (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  number           int not null,
  reporter_id      uuid,
  reporter_name    text not null check (length(btrim(reporter_name)) between 1 and 200),
  -- Snapshots: they outlive the member row and are what the tracker is told.
  reporter_role    text check (length(reporter_role) <= 100),
  title            text not null check (length(btrim(title)) between 1 and 200),
  body_md          text not null default '' check (length(body_md) <= 20000),
  source           text not null default 'form' check (source in ('form', 'assistant', 'help')),
  context          jsonb not null default '{}'::jsonb,
  status           text not null default 'open'
    constraint bug_reports_status check (status in ('open', 'resolved', 'not_planned', 'duplicate')),
  closed_at        timestamptz,
  tracker_repo     text,
  tracker_number   int,
  tracker_node_id  text,
  tracker_url      text,
  sync_state       text not null default 'pending'
    check (sync_state in ('pending', 'synced', 'failed', 'detached')),
  sync_error       text,
  last_activity_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (tenant_id, number),
  unique (tracker_repo, tracker_number)
);
create index bug_reports_tenant_activity_idx on public.bug_reports (tenant_id, last_activity_at desc, id desc);
create index bug_reports_activity_idx on public.bug_reports (last_activity_at desc, id desc);
create index bug_reports_unsynced_idx on public.bug_reports (sync_state) where sync_state <> 'synced';

-- The tenant's own "#12", not the tracker's. The advisory lock serialises two reports filed in the same
-- instant; the unique constraint is the backstop. Security definer so max() sees every row of the
-- tenant whatever the caller's policies; the tenant comes from NEW, which the insert policy has pinned.
create schema if not exists app;
create or replace function app.bug_reports_assign_number()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('bug_reports:' || new.tenant_id::text));
  select coalesce(max(r.number), 0) + 1 into new.number from public.bug_reports r where r.tenant_id = new.tenant_id;
  return new;
end;
$$;
revoke all on function app.bug_reports_assign_number() from public, anon, authenticated;
create trigger bug_reports_assign_number
  before insert on public.bug_reports for each row execute function app.bug_reports_assign_number();

alter table public.bug_reports enable row level security;
create policy bug_reports_select on public.bug_reports for select to authenticated
  using (tenant_id = app.current_tenant_id());
-- Insert as yourself, open, unsynced, with no tracker columns: the only way a report starts.
create policy bug_reports_insert on public.bug_reports for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and reporter_id = app.current_member_id()
    and status = 'open' and closed_at is null
    and sync_state = 'pending' and sync_error is null
    and tracker_repo is null and tracker_number is null and tracker_node_id is null and tracker_url is null
  );
revoke update, delete on public.bug_reports from anon, authenticated;

-- 2) Comments, both directions -------------------------------------------------------------------------
create table public.bug_report_comments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  report_id          uuid not null references public.bug_reports(id) on delete cascade,
  author_kind        text not null check (author_kind in ('member', 'operator', 'tracker')),
  author_member_id   uuid,
  author_name        text not null check (length(btrim(author_name)) between 1 and 200),
  tracker_login      text,
  body_md            text not null check (length(btrim(body_md)) between 1 and 20000),
  tracker_comment_id bigint unique,
  sync_state         text not null default 'pending' check (sync_state in ('pending', 'synced', 'failed', 'inbound')),
  edited_at          timestamptz,
  hidden_at          timestamptz,
  created_at         timestamptz not null default now()
);
create index bug_report_comments_report_idx on public.bug_report_comments (report_id, created_at);

alter table public.bug_report_comments enable row level security;
create policy bug_report_comments_select on public.bug_report_comments for select to authenticated
  using (tenant_id = app.current_tenant_id() and hidden_at is null);
create policy bug_report_comments_insert on public.bug_report_comments for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and author_kind = 'member'
    and author_member_id = app.current_member_id()
    -- The foreign key alone accepts another tenant's report id.
    and exists (select 1 from public.bug_reports r where r.id = report_id and r.tenant_id = app.current_tenant_id())
    and tracker_comment_id is null and tracker_login is null
    and sync_state = 'pending' and edited_at is null and hidden_at is null
  );
revoke update, delete on public.bug_report_comments from anon, authenticated;

-- 3) Attachments, uploaded straight from the browser ------------------------------------------------
create table public.bug_report_attachments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  report_id    uuid references public.bug_reports(id) on delete cascade,
  comment_id   uuid references public.bug_report_comments(id) on delete cascade,
  uploaded_by  uuid,
  storage_path text not null unique,
  file_name    text not null check (length(file_name) between 1 and 200),
  mime_type    text not null,
  size_bytes   int not null check (size_bytes > 0),
  status       text not null default 'pending' check (status in ('pending', 'ready')),
  created_at   timestamptz not null default now()
);
create index bug_report_attachments_report_idx on public.bug_report_attachments (report_id);
create index bug_report_attachments_orphan_idx on public.bug_report_attachments (created_at) where report_id is null;

alter table public.bug_report_attachments enable row level security;
create policy bug_report_attachments_select on public.bug_report_attachments for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy bug_report_attachments_insert on public.bug_report_attachments for insert to authenticated
  with check (
    tenant_id = app.current_tenant_id()
    and uploaded_by = app.current_member_id()
    and report_id is null and comment_id is null and status = 'pending'
    and storage_path like (app.current_tenant_id()::text || '/%')
  );
revoke update, delete on public.bug_report_attachments from anon, authenticated;

-- 4) The outbox to the tracker --------------------------------------------------------------------------
create table public.bug_report_jobs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  report_id   uuid not null references public.bug_reports(id) on delete cascade,
  comment_id  uuid references public.bug_report_comments(id) on delete cascade,
  kind        text not null check (kind in ('create_issue', 'post_comment')),
  dedupe_key  text not null,
  send_after  timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index bug_report_jobs_due_idx on public.bug_report_jobs (send_after) where status = 'pending';
create unique index bug_report_jobs_pending_uniq on public.bug_report_jobs (kind, dedupe_key) where status = 'pending';
alter table public.bug_report_jobs enable row level security;
revoke all on public.bug_report_jobs from public, anon, authenticated;

-- Claiming pushes send_after one lease out: two workers never run the same job, and a crashed worker's
-- job comes back by itself.
create or replace function public.claim_bug_report_jobs(p_limit int default 25, p_lease interval default interval '5 minutes')
returns setof public.bug_report_jobs language sql volatile security invoker set search_path = '' as $$
  update public.bug_report_jobs j
     set attempts = j.attempts + 1, send_after = now() + p_lease, updated_at = now()
   where j.id in (
     select id from public.bug_report_jobs
      where status = 'pending' and send_after <= now()
      order by send_after limit p_limit for update skip locked)
  returning j.*;
$$;
revoke all on function public.claim_bug_report_jobs(int, interval) from public, anon, authenticated;
grant execute on function public.claim_bug_report_jobs(int, interval) to service_role;

-- 5) Webhook ledger and bridge health ---------------------------------------------------------------
-- One row per GitHub delivery id: a redelivery is a conflict, and a conflict is a replay.
create table public.bug_report_deliveries (
  delivery_id text primary key,
  event       text not null,
  received_at timestamptz not null default now()
);
alter table public.bug_report_deliveries enable row level security;
revoke all on public.bug_report_deliveries from public, anon, authenticated;

-- One row. What the operator health view reads: when the bridge last heard from the tracker, why it last
-- ignored a delivery, when the worker last ran, and the reconcile cursor.
create table public.bug_report_bridge (
  id                 int primary key default 1 check (id = 1),
  last_delivery_at   timestamptz,
  last_ignored_at    timestamptz,
  last_ignore_reason text,
  last_worker_at     timestamptz,
  reconcile_cursor   timestamptz
);
insert into public.bug_report_bridge (id) values (1) on conflict do nothing;
alter table public.bug_report_bridge enable row level security;
revoke all on public.bug_report_bridge from public, anon, authenticated;

-- 6) The private bucket. No object policies: reached only through the service role after the app's own
-- check. The size and type limits repeat the action's; SVG and HTML are excluded because they execute.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bug-report-attachments', 'bug-report-attachments', false, 26214400,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'video/mp4', 'video/webm'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
```

Notes on the parts that look optional:

- **The insert policies pin every column a member could misuse**: status, sync state, tracker columns,
  the author kind of a comment. Without them a member can insert a report that already looks resolved, or
  a comment that looks like the team's.
- **The comment policy checks the report's tenant with `exists`.** The foreign key alone accepts another
  tenant's report id.
- **`revoke update, delete`** removes the privileges Supabase grants by default, so an update fails with a
  permission error instead of silently matching nothing.
- **The numbering trigger is `security definer`** so `max(number)` sees the whole tenant. The tenant comes
  from `NEW`, which the insert policy has already pinned to the caller's own.
- **The partial unique index on the outbox** keeps one pending job per report or comment, so a double
  submit cannot queue two issues.
- **`bug_report_bridge` is a single row**, enforced by the check on `id`. It holds what the health view
  reads and the reconcile cursor, so neither depends on a settings table the host may not have.

## Checks the migration was put through

Applied to an empty Postgres with stub `tenants`, `members` and the two `app` functions, with grants as
Supabase applies them, then exercised as the `authenticated` role:

| Check | Result |
|---|---|
| Two reports in tenant A, one in tenant B | numbered 1, 2 and 1 |
| Insert with `status` resolved, a tracker number, another tenant, or another member as reporter | refused by the policy |
| `update` or `delete` as a member | permission denied |
| Attachment reservation outside the tenant's folder | refused; inside it, accepted |
| Select from the outbox, or call the claim function, as a member | permission denied |
| Comment on another tenant's report, or as `tracker` | refused; as `member` on one's own, accepted |
| Tenant B selecting reports | sees none of tenant A's |
| The bucket | private, 25 MB limit |
