# The outbox: sending, retrying, reconciling, and the cron route

Saving a report writes the row and enqueues a `create_issue` job; a comment enqueues `post_comment`. The
action then tries the queue at once in `after()`, and the cron runs it every five minutes. Nothing the
member waits for calls GitHub.

| Job | Done when | On a retry |
|---|---|---|
| `create_issue` | The report row has `tracker_number` | Lists the label's recent issues for this report's marker before creating one |
| `post_comment` | The comment row has `tracker_comment_id` | Lists the issue's recent comments for this comment's marker before posting |

## The retry policy

```typescript
// lib/bug-reports/retry.ts

/**
 * What the outbox does with a job that failed. Pure, so the policy is tested rather than implied by
 * whichever branch happened to throw.
 */

/** Six tries against a five-minute cron: half an hour of the tracker being down, then parked. */
export const MAX_ATTEMPTS = 6;

/** The claim already pushes `send_after` this far out; a retry never comes sooner. */
export const LEASE_SECONDS = 300;

/** A comment whose issue is still in the outbox looks again this soon. */
export const WAIT_FOR_ISSUE_SECONDS = 60;

export type JobFailure = {
  message: string;
  /** The tracker's problem (5xx, 429, rate limit, network), not ours. */
  retryable: boolean;
  /** A comment job found its issue not created yet. Not the comment's failure. */
  waitingForIssue?: boolean;
  /** Seconds the tracker asked us to wait, when it said so. */
  retryAfterSeconds?: number | null;
};

export type RetryDecision =
  | { action: "retry"; attempts: number; delaySeconds: number; error: string }
  | { action: "park"; error: string };

/**
 * `attempts` is the count after the claim that ran this try. A comment waiting for its issue gets the
 * attempt back: waiting is not failing, and without the refund a comment filed in the same minute as its
 * report would be parked by the time a slow tracker recovered. The caller only reports
 * `waitingForIssue` while the issue job itself is still pending, so the wait cannot last forever.
 */
export function decideRetry(attempts: number, failure: JobFailure): RetryDecision {
  const error = failure.message.slice(0, 500);
  if (failure.waitingForIssue) {
    return { action: "retry", attempts: Math.max(0, attempts - 1), delaySeconds: WAIT_FOR_ISSUE_SECONDS, error };
  }
  if (failure.retryable && attempts < MAX_ATTEMPTS) {
    const delaySeconds = Math.max(LEASE_SECONDS, Math.ceil(failure.retryAfterSeconds ?? 0));
    return { action: "retry", attempts, delaySeconds, error };
  }
  return { action: "park", error };
}
```

A comment waiting for its issue is not failing. Without the refund, a comment written a minute after its
report would use up its attempts during a GitHub outage while the issue job, created first, still had some
left; the comment would be parked and the issue would not. The refund only applies while the issue job is
pending, so a parked issue parks its comments too, and the operator's retry re-queues both.

## The jobs

```typescript
// server/bug-reports/jobs.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GithubBridgeEnv } from "@/lib/github/env";
import { issueTitle, renderCommentBody, renderIssueBody, type AttachmentLink } from "@/lib/bug-reports/tracker-format";
import { TRACKER_STRINGS } from "@/lib/bug-reports/strings";
import type { ReportContext } from "@/lib/bug-reports/types";
import { bugReportsHost } from "./host";
import type { IssueTracker } from "./tracker";

/**
 * The two outbox jobs. Each is idempotent on its own row: it does nothing once the tracker id is stored,
 * and on a retry it first looks for the marker an earlier, half-finished attempt may have published, so
 * a crash between "the tracker answered" and "we saved the number" cannot open a duplicate.
 */
export type JobKind = "create_issue" | "post_comment";

export type JobRow = {
  id: string;
  tenant_id: string;
  report_id: string;
  comment_id: string | null;
  kind: JobKind;
  attempts: number;
  created_at: string;
};

/** A comment job found its issue still in the outbox. Not a failure of the comment: see lib/bug-reports/retry.ts. */
export class IssuePendingError extends Error {
  readonly name = "IssuePendingError";
}

/** The issue job gave up; the comment cannot be posted until an operator retries the report. */
export class IssueFailedError extends Error {
  readonly name = "IssueFailedError";
}

export async function enqueueJob(
  db: SupabaseClient,
  job: { tenantId: string; reportId: string; kind: JobKind; commentId?: string | null },
): Promise<void> {
  const { error } = await db.from("bug_report_jobs").insert({
    tenant_id: job.tenantId,
    report_id: job.reportId,
    comment_id: job.commentId ?? null,
    kind: job.kind,
    dedupe_key: job.commentId ?? job.reportId,
  });
  // A pending job for the same row already exists: one is enough.
  if (error && error.code !== "23505") throw new Error(`enqueue ${job.kind}: ${error.message}`);
}

/** Look back far enough to cover this job's first attempt. */
function since(job: JobRow): Date {
  return new Date(Date.parse(job.created_at) - 10 * 60_000);
}

async function attachmentsOf(db: SupabaseClient, reportId: string, commentId: string | null): Promise<AttachmentLink[]> {
  let q = db.from("bug_report_attachments").select("id, file_name").eq("report_id", reportId).eq("status", "ready").order("created_at");
  q = commentId ? q.eq("comment_id", commentId) : q.is("comment_id", null);
  const { data } = await q;
  return (data ?? []).map((a) => ({ id: a.id as string, fileName: a.file_name as string }));
}

export async function runJob(db: SupabaseClient, job: JobRow, tracker: IssueTracker, env: GithubBridgeEnv): Promise<void> {
  if (job.kind === "create_issue") return createIssue(db, job, tracker, env);
  return postComment(db, job, tracker, env);
}

async function createIssue(db: SupabaseClient, job: JobRow, tracker: IssueTracker, env: GithubBridgeEnv): Promise<void> {
  const { data: r, error } = await db
    .from("bug_reports")
    .select("id, tenant_id, number, reporter_name, reporter_role, title, body_md, source, context, created_at, tracker_number")
    .eq("id", job.report_id)
    .maybeSingle();
  if (error) throw new Error(`report load: ${error.message}`);
  if (!r || r.tracker_number) return;

  let issue = job.attempts > 1 ? await tracker.findIssueByMarker(r.id as string, since(job)) : null;
  if (!issue) {
    const tenant = await bugReportsHost.tenantLabel(r.tenant_id as string);
    issue = await tracker.createIssue({
      title: issueTitle(tenant.name, r.title as string),
      body: renderIssueBody({
        report: {
          id: r.id as string,
          number: r.number as number,
          bodyMd: r.body_md as string,
          source: r.source as string,
          createdAt: r.created_at as string,
          context: (r.context ?? {}) as ReportContext,
        },
        tenant,
        reporter: { name: r.reporter_name as string, roleLabel: (r.reporter_role as string | null) ?? null },
        attachments: await attachmentsOf(db, r.id as string, null),
        operatorOrigin: env.operatorOrigin,
        appVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      }),
      labels: [env.label],
    });
  }

  const { error: saveError } = await db
    .from("bug_reports")
    .update({
      tracker_repo: tracker.repo,
      tracker_number: issue.number,
      tracker_node_id: issue.nodeId,
      tracker_url: issue.url,
      sync_state: "synced",
      sync_error: null,
    })
    .eq("id", r.id);
  if (saveError) throw new Error(`report save: ${saveError.message}`);
}

async function postComment(db: SupabaseClient, job: JobRow, tracker: IssueTracker, env: GithubBridgeEnv): Promise<void> {
  if (!job.comment_id) return;
  const { data: c, error } = await db
    .from("bug_report_comments")
    .select("id, report_id, tenant_id, author_kind, author_name, body_md, tracker_comment_id")
    .eq("id", job.comment_id)
    .maybeSingle();
  if (error) throw new Error(`comment load: ${error.message}`);
  if (!c || c.tracker_comment_id) return;

  const { data: r } = await db.from("bug_reports").select("tracker_number, sync_state").eq("id", c.report_id).maybeSingle();
  const issueNumber = (r?.tracker_number as number | null | undefined) ?? null;
  if (!issueNumber) {
    if (r?.sync_state === "pending") throw new IssuePendingError("The issue is still in the outbox");
    throw new IssueFailedError("The issue was never created");
  }

  let posted = job.attempts > 1 ? await tracker.findCommentByMarker(issueNumber, c.id as string, since(job)) : null;
  if (!posted) {
    const tenant = await bugReportsHost.tenantLabel(c.tenant_id as string);
    const authorLabel =
      c.author_kind === "operator" ? TRACKER_STRINGS.operatorAuthor : `${c.author_name as string} (${tenant.name})`;
    posted = await tracker.createComment(
      issueNumber,
      renderCommentBody({
        commentId: c.id as string,
        authorLabel,
        bodyMd: c.body_md as string,
        attachments: await attachmentsOf(db, c.report_id as string, c.id as string),
        operatorOrigin: env.operatorOrigin,
      }),
    );
  }
  const { error: saveError } = await db
    .from("bug_report_comments")
    .update({ tracker_comment_id: posted.id, sync_state: "synced" })
    .eq("id", c.id);
  if (saveError) throw new Error(`comment save: ${saveError.message}`);
}

/** The job is parked: say so on the row the operator view shows. */
export async function markParked(db: SupabaseClient, job: JobRow, message: string): Promise<void> {
  if (job.kind === "create_issue") {
    await db.from("bug_reports").update({ sync_state: "failed", sync_error: message }).eq("id", job.report_id);
    return;
  }
  if (job.comment_id) await db.from("bug_report_comments").update({ sync_state: "failed" }).eq("id", job.comment_id);
  await db.from("bug_reports").update({ sync_error: message }).eq("id", job.report_id);
}
```

The marker search looks back from ten minutes before the job was created. That covers every earlier
attempt of the same job, and listing by label with `since` keeps the request to one page.

## The worker

```typescript
// server/bug-reports/worker.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { githubBridgeEnv, type GithubBridgeEnv } from "@/lib/github/env";
import { mapIssueState } from "@/lib/bug-reports/tracker-format";
import { decideRetry, type JobFailure } from "@/lib/bug-reports/retry";
import { GithubError } from "@/server/github/app";
import { sweepOrphanAttachments } from "./attachments";
import { touchBridge, readReconcileCursor } from "./health";
import { bugReportsHost } from "./host";
import { IssuePendingError, markParked, runJob, type JobRow } from "./jobs";
import { githubTracker, type IssueTracker } from "./tracker";
import { applyStatus, findReport } from "./webhook";

/**
 * Claims due jobs, runs them, then sweeps unclaimed uploads and reconciles statuses with the tracker,
 * which catches a webhook that was never delivered. Unconfigured, it does nothing at all: reports wait
 * in the outbox and go out the moment the App is set up, and nothing is parked for want of a secret.
 */
export type WorkerReport =
  | { skipped: "not_configured" }
  | { claimed: number; done: number; parked: number; deferred: number; swept: number; reconciled: number };

function asFailure(err: unknown): JobFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof IssuePendingError) return { message, retryable: true, waitingForIssue: true };
  if (err instanceof GithubError) return { message, retryable: err.retryable, retryAfterSeconds: err.retryAfterSeconds };
  // Anything else is a database blip or an IssueFailedError; MAX_ATTEMPTS bounds the first, the second parks.
  return { message, retryable: !(err instanceof Error && err.name === "IssueFailedError") };
}

export async function processDueJobs(
  limit = 25,
  deps: { env?: GithubBridgeEnv | null; tracker?: IssueTracker; db?: SupabaseClient; reconcile?: boolean } = {},
): Promise<WorkerReport> {
  const env = deps.env === undefined ? githubBridgeEnv() : deps.env;
  if (!env) return { skipped: "not_configured" };
  const db = deps.db ?? bugReportsHost.serviceDb();
  const tracker = deps.tracker ?? githubTracker(env);

  const { data, error } = await db.rpc("claim_bug_report_jobs", { p_limit: limit, p_lease: "5 minutes" });
  if (error) throw new Error(`claim_bug_report_jobs: ${error.message}`);
  // Issue jobs first: a comment job in the same batch then finds its issue.
  const jobs = ((data ?? []) as JobRow[]).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "create_issue" ? -1 : 1));

  let done = 0;
  let parked = 0;
  let deferred = 0;
  for (const job of jobs) {
    try {
      await runJob(db, job, tracker, env);
      await db.from("bug_report_jobs").update({ status: "sent", last_error: null }).eq("id", job.id);
      done += 1;
    } catch (err) {
      const decision = decideRetry(job.attempts, asFailure(err));
      if (decision.action === "retry") {
        await db
          .from("bug_report_jobs")
          .update({
            attempts: decision.attempts,
            send_after: new Date(Date.now() + decision.delaySeconds * 1000).toISOString(),
            last_error: decision.error,
          })
          .eq("id", job.id);
        deferred += 1;
        continue;
      }
      await db.from("bug_report_jobs").update({ status: "failed", last_error: decision.error }).eq("id", job.id);
      await markParked(db, job, decision.error);
      parked += 1;
    }
  }

  await touchBridge(db, { last_worker_at: new Date().toISOString() });
  if (deps.reconcile === false) return { claimed: jobs.length, done, parked, deferred, swept: 0, reconciled: 0 };
  const swept = await sweepOrphanAttachments(db).catch(() => 0);
  const reconciled = await reconcileStatuses(db, tracker).catch((err) => {
    console.error("[bug-reports] reconcile failed", err);
    return 0;
  });
  return { claimed: jobs.length, done, parked, deferred, swept, reconciled };
}

/**
 * Every bridged issue the tracker touched since the cursor gets its state re-applied. Idempotent:
 * `applyStatus` writes and notifies only on a real change. GitHub's `since` is inclusive, so the last
 * issue is seen twice, which is harmless; ordering by update time keeps the cursor monotonic.
 */
export async function reconcileStatuses(db: SupabaseClient, tracker: IssueTracker): Promise<number> {
  const stored = await readReconcileCursor(db);
  const since = stored ? new Date(stored) : new Date(Date.now() - 24 * 3600_000);
  const issues = await tracker.listUpdatedIssues(since);
  let changed = 0;
  let cursor = since.toISOString();
  for (const issue of issues) {
    const report = await findReport(db, tracker.repo, { number: issue.number, body: issue.body });
    if (report && (await applyStatus(db, report, mapIssueState(issue.state, issue.stateReason), null, "reconcile"))) changed += 1;
    if (issue.updatedAt > cursor) cursor = issue.updatedAt;
  }
  await touchBridge(db, { reconcile_cursor: cursor });
  return changed;
}
```

The claim pushes `send_after` five minutes out before anything runs: two workers never run one job, and a
worker that crashes mid-job leaves it to come back by itself. Issue jobs are run before comment jobs in a
batch, so a report and its first comment usually go out in one run.

Reconcile reads the bridged issues GitHub updated since the cursor, oldest first, and re-applies their
state. It is the backstop for a webhook that was never delivered: a status change that missed the hook
arrives within five minutes anyway. Comments have no backstop, which is why the webhook answers 500 on
failure and an operator redelivers.

```typescript
// server/bug-reports/health.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The bridge's own pulse, for the operator view. Derived from timestamps the bridge writes as it works,
 * so a worker that stopped running shows as stale instead of looking healthy.
 */
export type BridgeHealth = {
  configured: boolean;
  lastDeliveryAt: string | null;
  lastIgnoredAt: string | null;
  lastIgnoreReason: string | null;
  lastWorkerAt: string | null;
  pendingJobs: number;
  failedReports: number;
};

type Patch = Partial<{
  last_delivery_at: string;
  last_ignored_at: string;
  last_ignore_reason: string;
  last_worker_at: string;
  reconcile_cursor: string;
}>;

export async function touchBridge(db: SupabaseClient, patch: Patch): Promise<void> {
  const { error } = await db.from("bug_report_bridge").update(patch).eq("id", 1);
  if (error) console.error("[bug-reports] bridge state", error.message);
}

export async function readReconcileCursor(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from("bug_report_bridge").select("reconcile_cursor").eq("id", 1).maybeSingle();
  return (data?.reconcile_cursor as string | null | undefined) ?? null;
}

export async function bridgeHealth(db: SupabaseClient, configured: boolean): Promise<BridgeHealth> {
  const [{ data: row }, jobs, failed] = await Promise.all([
    db.from("bug_report_bridge").select("*").eq("id", 1).maybeSingle(),
    db.from("bug_report_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    db.from("bug_reports").select("id", { count: "exact", head: true }).eq("sync_state", "failed"),
  ]);
  return {
    configured,
    lastDeliveryAt: (row?.last_delivery_at as string | null | undefined) ?? null,
    lastIgnoredAt: (row?.last_ignored_at as string | null | undefined) ?? null,
    lastIgnoreReason: (row?.last_ignore_reason as string | null | undefined) ?? null,
    lastWorkerAt: (row?.last_worker_at as string | null | undefined) ?? null,
    pendingJobs: jobs.count ?? 0,
    failedReports: failed.count ?? 0,
  };
}

/** The worker runs every five minutes; three missed runs is a stopped cron, not a slow one. */
export function workerStale(health: BridgeHealth, now: Date = new Date()): boolean {
  if (!health.lastWorkerAt) return true;
  return now.getTime() - Date.parse(health.lastWorkerAt) > 15 * 60_000;
}
```

## The cron route

```typescript
// app/api/bug-reports/worker/route.ts
import { NextResponse } from "next/server";
import { processDueJobs } from "@/server/bug-reports/worker";

/**
 * Vercel Cron, every five minutes (`vercel.json`). Fail closed: 503 when CRON_SECRET is unset, 401 when
 * the bearer does not match. The path is in CRON_PATHS, so the proxy lets it through on any host.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Worker not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await processDueJobs());
}
```

```json
{ "crons": [{ "path": "/api/bug-reports/worker", "schedule": "*/5 * * * *" }] }
```

That goes in `vercel.json` next to the host's other crons.

## The proxy bypass

Vercel Cron calls the deployment's own `*.vercel.app` host. A multi-tenant proxy resolves the tenant from
the host, finds none, and answers 404 before the route runs: every worker in the app stops, not only this
one, and the only trace is a 404 in the logs. Local development hides it, because a seeded wildcard domain
usually maps `*.vercel.app` to a test tenant.

```typescript
// lib/cron-paths.ts

/**
 * Every route Vercel Cron calls: the `crons` list in `vercel.json`, and nothing else.
 *
 * Cron calls the deployment's own `*.vercel.app` host, which belongs to no tenant. A proxy that resolves
 * the tenant from the host answers it 404 and no worker ever runs. These routes authenticate themselves
 * with `CRON_SECRET` and read no tenant, so the proxy passes them through on any host.
 * `cron-paths.test.ts` keeps the list equal to `vercel.json`.
 */
export const CRON_PATHS: readonly string[] = ["/api/bug-reports/worker"];

export function isCronPath(pathname: string): boolean {
  return CRON_PATHS.includes(pathname.replace(/\/$/, ""));
}
```

Add every path from `vercel.json` to `CRON_PATHS`, not only this module's. The test in testing.md fails
when the two lists differ.

```typescript
// proxy.ts (the first lines of the host's proxy function)
import { NextResponse, type NextRequest } from "next/server";
import { isCronPath } from "@/lib/cron-paths";

export async function proxy(request: NextRequest) {
  // Before tenant resolution: Vercel Cron calls the deployment's own *.vercel.app host, which no tenant
  // owns. The workers authenticate with CRON_SECRET and read no tenant, so they skip it, and any tenant
  // header a caller spoofed is dropped on the way.
  if (isCronPath(request.nextUrl.pathname)) {
    const headers = new Headers(request.headers);
    headers.delete("x-tenant-id");
    return NextResponse.next({ request: { headers } });
  }
  // ... the host's own proxy continues here: marketing, operator host, tenant resolution, auth.
  return NextResponse.next();
}
```

A host with no proxy yet gets a new `proxy.ts` holding this block, so the bypass is already in place when
tenant resolution is added, rather than remembered then: local development never shows the 404.

The bypass goes first in the proxy, before any host logic. The routes it admits authenticate themselves
with `CRON_SECRET` and fail closed without it, so the proxy loses nothing by not looking at them. Copy it
as written, the header strip included, even in a proxy that sets no tenant header yet. The one harmless
addition is `/api/github/webhook` as a second condition beside `isCronPath`, never in `CRON_PATHS`: it
verifies its own signature and reads no tenant. GitHub still delivers to the operator host (webhook.md).
