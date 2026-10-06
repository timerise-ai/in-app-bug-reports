# The webhook: GitHub back into the app

GitHub's state becomes the report's status, and a team comment that opts in with `/reply` becomes a reply
in the member's thread. Everything else the team writes on the issue stays on GitHub.

## The order

1. Read the raw body. The signature is over the bytes GitHub sent, never a re-serialised object.
2. Verify `X-Hub-Signature-256`: 503 when no secret is configured, 401 when it does not match.
3. Answer `ping` with 200.
4. Plan the delivery: which event, which installation, which repository, what it means.
5. Find the report: by repository and issue number, then by the marker in the issue body.
6. Claim the delivery id in the ledger; a conflict is a replay and changes nothing.
7. Apply the plan. On failure, release the claim and answer 500.

## Signature

```typescript
// lib/github/signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `X-Hub-Signature-256`: HMAC-SHA256 of the raw body, as `sha256=<hex>`. Hash the bytes GitHub sent,
 * never a re-serialised object. Fail closed on a missing secret or header, and return false on a length
 * mismatch instead of letting `timingSafeEqual` throw: a throw is a 500, and a 500 is a redelivery.
 */
const PREFIX = "sha256=";

export function signGithubPayload(rawBody: string, secret: string): string {
  return PREFIX + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyGithubSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || !header || !header.startsWith(PREFIX)) return false;
  const expected = Buffer.from(signGithubPayload(rawBody, secret), "utf8");
  const received = Buffer.from(header, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
```

## What a delivery means

```typescript
// lib/bug-reports/webhook-plan.ts
import { mapIssueState, parseCommentMarker, parseReplyCommand } from "./tracker-format";
import type { ReportStatus } from "./types";

/**
 * What one GitHub delivery means for the app, decided before any database is touched. The handler
 * applies the plan; this function is where every rule about which events count lives, and the tests
 * hold it.
 */

export type GithubUser = { login?: string; type?: string } | null;
export type GithubIssuePayload = {
  number: number;
  state: string;
  state_reason?: string | null;
  closed_at?: string | null;
  body?: string | null;
  pull_request?: unknown;
};
export type GithubCommentPayload = {
  id: number;
  body?: string | null;
  user?: GithubUser;
  author_association?: string;
  performed_via_github_app?: { id?: number } | null;
};
export type GithubPayload = {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  issue?: GithubIssuePayload;
  comment?: GithubCommentPayload;
};

export type BridgeIdentity = { appId: string; installationId: string; repo: string };

export type IssueRef = { number: number; body: string | null };

export type DeliveryPlan =
  /** `misconfigured`: the App points somewhere this deployment does not serve. Shown on the health view. */
  | { kind: "ignore"; reason: string; misconfigured: boolean }
  | { kind: "status"; issue: IssueRef; status: ReportStatus; closedAt: string | null }
  | { kind: "detach"; issue: IssueRef; action: string }
  | { kind: "echo"; issue: IssueRef; trackerCommentId: number; localCommentId: string | null }
  | {
      kind: "comment";
      issue: IssueRef;
      trackerCommentId: number;
      visible: boolean;
      body: string;
      login: string | null;
    }
  | { kind: "comment_deleted"; issue: IssueRef; trackerCommentId: number };

/** A comment the App posted on the app's behalf: it carries a marker, or GitHub says the App made it. */
export function isOwnComment(comment: GithubCommentPayload, appId: string): boolean {
  if (parseCommentMarker(comment.body)) return true;
  const via = comment.performed_via_github_app?.id;
  return via != null && String(via) === appId;
}

export function planDelivery(event: string, payload: GithubPayload, bridge: BridgeIdentity): DeliveryPlan {
  if (event !== "issues" && event !== "issue_comment") return { kind: "ignore", reason: `event:${event}`, misconfigured: false };
  if (String(payload.installation?.id ?? "") !== bridge.installationId) {
    return { kind: "ignore", reason: "installation", misconfigured: true };
  }
  if ((payload.repository?.full_name ?? "").toLowerCase() !== bridge.repo.toLowerCase()) {
    return { kind: "ignore", reason: "repository", misconfigured: true };
  }
  const issuePayload = payload.issue;
  if (!issuePayload || issuePayload.pull_request) return { kind: "ignore", reason: "not_an_issue", misconfigured: false };
  const issue: IssueRef = { number: issuePayload.number, body: issuePayload.body ?? null };
  const action = payload.action ?? "";

  if (event === "issues") {
    if (action === "closed" || action === "reopened") {
      const status = mapIssueState(issuePayload.state, issuePayload.state_reason);
      return { kind: "status", issue, status, closedAt: status === "open" ? null : (issuePayload.closed_at ?? null) };
    }
    if (action === "deleted" || action === "transferred") return { kind: "detach", issue, action };
    // `edited`, `labeled` and the rest: a retitle on the tracker is the team's business, not the tenant's.
    return { kind: "ignore", reason: `issues.${action}`, misconfigured: false };
  }

  const comment = payload.comment;
  if (!comment) return { kind: "ignore", reason: "no_comment", misconfigured: false };
  if (action === "deleted") return { kind: "comment_deleted", issue, trackerCommentId: comment.id };
  if (action !== "created" && action !== "edited") {
    return { kind: "ignore", reason: `issue_comment.${action}`, misconfigured: false };
  }
  if (isOwnComment(comment, bridge.appId)) {
    return {
      kind: "echo",
      issue,
      trackerCommentId: comment.id,
      localCommentId: parseCommentMarker(comment.body),
    };
  }
  const reply = parseReplyCommand(comment.body, comment.author_association);
  return {
    kind: "comment",
    issue,
    trackerCommentId: comment.id,
    visible: reply.visible,
    body: reply.body.slice(0, 20_000),
    login: comment.user?.login ?? null,
  };
}
```

| Event | Action | Plan |
|---|---|---|
| `issues` | `closed`, `reopened` | Status from `state` and `state_reason` |
| `issues` | `deleted`, `transferred` | Detach: the report keeps its status, the operator sees it is no longer bridged |
| `issues` | `edited`, `labeled` and the rest | Ignore: a retitle on GitHub is the team's business |
| `issue_comment` | `created`, `edited` by the App | Echo: backfill the local comment's tracker id, never mirror |
| `issue_comment` | `created`, `edited` by anyone else | Mirror when `/reply` from the team; hide a mirror whose `/reply` was removed |
| `issue_comment` | `deleted` | Hide the mirror, if there was one |
| anything | from another installation or repository | Ignore, and record it as a misconfiguration |

**The visibility rule.** A comment reaches the tenant only when its first line starts with `/reply` and its
`author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. The prefix is removed before mirroring. The
repository carries the team's own conversation about the bug, the stack traces, the guesses; a rule that
mirrored everything except an `/internal` marker would leak it the first time someone forgot.

**Echoes.** The App posts members' and operators' comments with a marker. When the webhook for that comment
arrives it is recognised by the marker, or by `performed_via_github_app`, and only fills in the tracker id
if the worker has not yet. An edit on GitHub to a comment the app posted never rewrites the member's text.

## Applying it

```typescript
// server/bug-reports/webhook.ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GithubBridgeEnv } from "@/lib/github/env";
import { parseReportMarker } from "@/lib/bug-reports/tracker-format";
import type { ReportStatus } from "@/lib/bug-reports/types";
import { planDelivery, type DeliveryPlan, type GithubPayload, type IssueRef } from "@/lib/bug-reports/webhook-plan";
import { bugReportsHost } from "./host";
import { touchBridge } from "./health";
import { notifyFollowers } from "./notify";

/**
 * GitHub to the app. The tracker owns the status of a bridged issue: this applies what it says, and
 * mirrors the comments that opted in with `/reply`. Every delivery is claimed in the ledger first, so a
 * redelivery is a no-op; a failure releases the claim, so the operator's "Redeliver" retries it.
 */
export type ReportRow = { id: string; tenant_id: string; number: number; title: string; reporter_id: string | null; status: ReportStatus };

const REPORT_COLUMNS = "id, tenant_id, number, title, reporter_id, status";

/** By stored number first; then by the marker, for a delivery that beat the worker saving the number. */
export async function findReport(db: SupabaseClient, repo: string, issue: IssueRef): Promise<ReportRow | null> {
  const { data } = await db.from("bug_reports").select(REPORT_COLUMNS).eq("tracker_repo", repo).eq("tracker_number", issue.number).maybeSingle();
  if (data) return data as ReportRow;
  const marker = parseReportMarker(issue.body);
  if (!marker) return null;
  const { data: byMarker } = await db.from("bug_reports").select(REPORT_COLUMNS).eq("id", marker).maybeSingle();
  return (byMarker as ReportRow | null) ?? null;
}

/** Apply the tracker's state; true only when it changed something, and only then notify. */
export async function applyStatus(
  db: SupabaseClient,
  report: ReportRow,
  status: ReportStatus,
  closedAt: string | null,
  via: "webhook" | "reconcile",
): Promise<boolean> {
  if (status === report.status) return false;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("bug_reports")
    .update({ status, closed_at: status === "open" ? null : (closedAt ?? now), last_activity_at: now })
    .eq("id", report.id)
    .neq("status", status)
    .select("id");
  if (error) throw new Error(`report status: ${error.message}`);
  if (!data?.length) return false;
  await bugReportsHost.audit({ tenantId: report.tenant_id, actor: null, action: "bug_report.status", reportId: report.id, data: { from: report.status, to: status, via } });
  await notifyFollowers(db, report, { kind: "status", status });
  return true;
}

export async function processDelivery(
  env: GithubBridgeEnv,
  event: string,
  deliveryId: string,
  payload: GithubPayload,
  db: SupabaseClient = bugReportsHost.serviceDb(),
): Promise<{ applied: string }> {
  const now = new Date().toISOString();
  const plan = planDelivery(event, payload, { appId: env.appId, installationId: env.installationId, repo: `${env.owner}/${env.repo}` });
  if (plan.kind === "ignore") {
    // Logged and recorded: a 200 that ignores everything is how a misconfigured App hides.
    if (plan.misconfigured) {
      console.warn("[bug-reports] webhook ignored", plan.reason);
      await touchBridge(db, { last_delivery_at: now, last_ignored_at: now, last_ignore_reason: plan.reason });
    }
    return { applied: `ignored:${plan.reason}` };
  }

  const report = await findReport(db, `${env.owner}/${env.repo}`, plan.issue);
  if (!report) {
    await touchBridge(db, { last_delivery_at: now, last_ignored_at: now, last_ignore_reason: `unknown_issue:${plan.issue.number}` });
    return { applied: "ignored:unknown_issue" };
  }

  const { error: claimError } = await db.from("bug_report_deliveries").insert({ delivery_id: deliveryId, event: `${event}.${payload.action ?? ""}` });
  if (claimError) {
    if (claimError.code === "23505") return { applied: "replay" };
    throw new Error(`delivery claim: ${claimError.message}`);
  }
  try {
    const applied = await apply(db, plan, report);
    await touchBridge(db, { last_delivery_at: now });
    return { applied };
  } catch (err) {
    await db.from("bug_report_deliveries").delete().eq("delivery_id", deliveryId);
    throw err;
  }
}

async function apply(db: SupabaseClient, plan: Exclude<DeliveryPlan, { kind: "ignore" }>, report: ReportRow): Promise<string> {
  switch (plan.kind) {
    case "status":
      return (await applyStatus(db, report, plan.status, plan.closedAt, "webhook")) ? `status:${plan.status}` : "status:unchanged";

    case "detach":
      await db.from("bug_reports").update({ sync_state: "detached" }).eq("id", report.id);
      await bugReportsHost.audit({ tenantId: report.tenant_id, actor: null, action: "bug_report.detached", reportId: report.id, data: { action: plan.action } });
      return `detached:${plan.action}`;

    case "echo":
      // The App's own comment coming back: backfill its id if the worker has not yet, never mirror it.
      if (plan.localCommentId) {
        await db
          .from("bug_report_comments")
          .update({ tracker_comment_id: plan.trackerCommentId, sync_state: "synced" })
          .eq("id", plan.localCommentId)
          .eq("report_id", report.id)
          .is("tracker_comment_id", null);
      }
      return "echo";

    case "comment_deleted": {
      const { data } = await db
        .from("bug_report_comments")
        .update({ hidden_at: new Date().toISOString() })
        .eq("tracker_comment_id", plan.trackerCommentId)
        .eq("author_kind", "tracker")
        .select("id");
      return data?.length ? "comment:hidden" : "ignored:not_mirrored";
    }

    case "comment": {
      const { data: mirror } = await db
        .from("bug_report_comments")
        .select("id, author_kind, hidden_at")
        .eq("tracker_comment_id", plan.trackerCommentId)
        .maybeSingle();
      // An edit on the tracker never rewrites what a member wrote in the app.
      if (mirror && mirror.author_kind !== "tracker") return "ignored:own_comment";
      if (mirror) {
        if (!plan.visible) {
          await db.from("bug_report_comments").update({ hidden_at: (mirror.hidden_at as string | null) ?? new Date().toISOString() }).eq("id", mirror.id);
          return "comment:hidden";
        }
        await db.from("bug_report_comments").update({ body_md: plan.body, edited_at: new Date().toISOString(), hidden_at: null }).eq("id", mirror.id);
        return "comment:updated";
      }
      if (!plan.visible) return "comment:internal";
      const { error } = await db.from("bug_report_comments").insert({
        tenant_id: report.tenant_id,
        report_id: report.id,
        author_kind: "tracker",
        author_name: "team",
        tracker_login: plan.login,
        body_md: plan.body,
        tracker_comment_id: plan.trackerCommentId,
        sync_state: "inbound",
      });
      if (error) {
        if (error.code === "23505") return "comment:duplicate";
        throw new Error(`comment mirror: ${error.message}`);
      }
      await db.from("bug_reports").update({ last_activity_at: new Date().toISOString() }).eq("id", report.id);
      await notifyFollowers(db, report, { kind: "reply", body: plan.body });
      return "comment:mirrored";
    }
  }
}
```

`applyStatus` updates only when the status changes (`neq` in the update itself), and only then audits and
notifies. A webhook and the reconcile pass seeing the same close therefore produce one notification.

## The route

```typescript
// app/api/github/webhook/route.ts
import { NextResponse } from "next/server";
import { githubBridgeEnv, githubWebhookSecret } from "@/lib/github/env";
import { verifyGithubSignature } from "@/lib/github/signature";
import type { GithubPayload } from "@/lib/bug-reports/webhook-plan";
import { processDelivery } from "@/server/bug-reports/webhook";

/**
 * The GitHub App's webhook, events "Issues" and "Issue comment". Served on the operator origin, which the
 * proxy answers without resolving a tenant. Order: raw body, signature (503 when no secret, 401 when it
 * does not match), ping, then process.
 *
 * Processed inline, not in after(): GitHub does not redeliver on its own, so a failure must show as a 500
 * in the App's delivery log, where an operator presses Redeliver. The ledger makes that safe, and the
 * work is a few queries, well inside GitHub's ten seconds.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = githubWebhookSecret();
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });

  const raw = await request.text();
  if (raw.length > 1024 * 1024) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  if (!verifyGithubSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") return NextResponse.json({ ok: true });
  const delivery = request.headers.get("x-github-delivery");
  if (!delivery) return NextResponse.json({ error: "Missing delivery id" }, { status: 400 });

  const env = githubBridgeEnv();
  if (!env) return NextResponse.json({ error: "GitHub App not configured" }, { status: 503 });

  let payload: GithubPayload;
  try {
    payload = JSON.parse(raw) as GithubPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    // The body says what happened, ignored or not: that is what the App's delivery log shows.
    return NextResponse.json(await processDelivery(env, event, delivery, payload));
  } catch (err) {
    console.error("[bug-reports] webhook failed", err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
```

**Inline, not after the response.** GitHub does not retry a failed delivery on its own. Processing in
`after()` would answer 200 and lose a failure silently; processing inline turns it into a 500 in the App's
"Recent deliveries", where an operator presses Redeliver, and the ledger makes the redelivery safe. The
work is a handful of queries, far inside GitHub's ten-second budget.

**The host.** The URL is on `OPERATOR_ORIGIN`, which the proxy must serve without resolving a tenant. If
it does not, every delivery answers "Domain not configured" with a 404 from the proxy, before this route
runs. Probe it after deploying: an unsigned `POST` must answer 401 "Invalid signature", from the route.

```bash
curl -s -X POST "$OPERATOR_ORIGIN/api/github/webhook" -w " %{http_code}\n"
# {"error":"Invalid signature"} 401
```

**Why 200 for an ignored delivery.** A hook that answers 4xx to events it does not care about is marked
failing by GitHub. The body says what happened (`{"applied":"ignored:repository"}`), the App's delivery
log shows it, and a misconfigured installation or repository is written to the bridge row for the health
view.
