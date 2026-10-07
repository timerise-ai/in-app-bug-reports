# The GitHub side: the App, its client, the tracker seam, what an issue says

## Register the App

One GitHub App per project, and a second one for preview deployments, each installed on one repository.
An App has a single webhook URL, so two deployments sharing one App deliver every event to one of them.

| Setting | Value |
|---|---|
| Webhook URL | `${OPERATOR_ORIGIN}/api/github/webhook` |
| Webhook secret | 32 random bytes, hex: `openssl rand -hex 32` |
| Repository permissions | Issues: read and write. Metadata: read-only, which GitHub adds as mandatory. Nothing else |
| Events | Issues, Issue comment |
| Installable on | Only this account |
| Installation | Only select repositories: the one repository the team triages in |

After creating it: note the App ID, generate a private key (a `.pem` download), install it, and read the
installation id from the end of the installation page URL. Create the label the bridge applies,
`tenant-report`, and `tenant-report-preview` for the preview App. A private repository is required:
report text is whatever a member typed.

## Environment

| Variable | Contents |
|---|---|
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | The PEM, one line with `\n` escapes: `awk 'NF {printf "%s\\n", $0}' key.pem` |
| `GITHUB_APP_INSTALLATION_ID` | The number at the end of the installation URL |
| `GITHUB_REPORTS_REPO` | `owner/name` |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret, the same value as in the App |
| `OPERATOR_ORIGIN` | The operator host's origin, used for links in issues |
| `GITHUB_REPORTS_LABEL` | Optional; `tenant-report` by default, `tenant-report-preview` on preview |
| `CRON_SECRET` | The bearer Vercel Cron sends to the worker |

All of them are read at request time and none at build time. Missing any of the first six turns the bridge
off without an error: reports are saved and wait.

The module also reads three Supabase variables, under the names Supabase's own guides use:
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `host.ts`, and `NEXT_PUBLIC_SUPABASE_URL`
with `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the upload picker. The two `NEXT_PUBLIC_` values are inlined into the
browser bundle when the app is built; nothing fails without them.

Write all eleven to `.env.example` at the app root, empty, with every name spelled as here. Add the host's
own below them (an operator allowlist, say), never a renamed one, and when `.gitignore` ignores `.env*`, add
`!.env.example` so the file is tracked. Real values go in the deployment's environment, never in a tracked
file.

```bash
# .env.example
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_REPORTS_REPO=
GITHUB_WEBHOOK_SECRET=
OPERATOR_ORIGIN=
GITHUB_REPORTS_LABEL=
CRON_SECRET=
```

```typescript
// lib/github/env.ts

/**
 * GitHub App configuration, read in one place so a half-configured environment is one answer, null,
 * rather than an error halfway through a sync. Null keeps the module working: reports are saved and
 * wait in the outbox until the App is configured.
 */
export type GithubBridgeEnv = {
  appId: string;
  /** PEM, PKCS#1 or PKCS#8. `\n` escapes from a one-line variable are restored. */
  privateKey: string;
  installationId: string;
  owner: string;
  repo: string;
  webhookSecret: string;
  /** The label every bridged issue carries. Set a second one on preview deployments. */
  label: string;
  /** Where operators open the app and attachments: an origin the proxy serves without a tenant. */
  operatorOrigin: string;
};

export const DEFAULT_REPORT_LABEL = "tenant-report";

type Source = Record<string, string | undefined>;

export function parseRepo(value: string | undefined): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(value?.trim() ?? "");
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

export function githubBridgeEnv(source: Source = process.env): GithubBridgeEnv | null {
  const appId = source.GITHUB_APP_ID?.trim();
  const privateKey = source.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const installationId = source.GITHUB_APP_INSTALLATION_ID?.trim();
  const repo = parseRepo(source.GITHUB_REPORTS_REPO);
  const webhookSecret = source.GITHUB_WEBHOOK_SECRET?.trim();
  const operatorOrigin = source.OPERATOR_ORIGIN?.trim().replace(/\/$/, "");
  if (!appId || !privateKey || !installationId || !repo || !webhookSecret || !operatorOrigin) return null;
  return {
    appId,
    privateKey,
    installationId,
    ...repo,
    webhookSecret,
    label: source.GITHUB_REPORTS_LABEL?.trim() || DEFAULT_REPORT_LABEL,
    operatorOrigin,
  };
}

/** The webhook secret alone: the route verifies before it needs anything else. */
export function githubWebhookSecret(source: Source = process.env): string | null {
  return source.GITHUB_WEBHOOK_SECRET?.trim() || null;
}
```

## The client

No SDK: the App needs one signed JWT to trade for a token, and the bridge makes five kinds of call.

```typescript
// server/github/app.ts
import "server-only";
import { createPrivateKey, sign } from "node:crypto";
import type { GithubBridgeEnv } from "@/lib/github/env";

/**
 * A GitHub App client in under a hundred lines, no SDK: an RS256 JWT signed with node:crypto, traded for
 * an installation token narrowed to one repository and to issues, cached until five minutes before it
 * expires.
 */

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "bug-report-bridge";

/** `retryable` is what the outbox decides from: the tracker's outage, not our malformed payload. */
export class GithubError extends Error {
  readonly name = "GithubError";
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, opts: { status?: number; retryable?: boolean; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.status = opts.status ?? 0;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The App's own JWT: at most ten minutes, backdated 60 seconds for clock skew. */
export function createAppJwt(appId: string, pem: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const data = `${header}.${payload}`;
  return `${data}.${base64url(sign("sha256", Buffer.from(data), createPrivateKey(pem)))}`;
}

let cached: { token: string; expiresAt: number; key: string } | null = null;

export function resetGithubTokenCache(): void {
  cached = null;
}

function classify(status: number, headers: Headers, body: string): GithubError {
  const retryAfter = Number(headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  const rateLimited = status === 403 && (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(body));
  const retryable = status >= 500 || status === 429 || rateLimited;
  return new GithubError(`GitHub ${status}: ${body.slice(0, 300)}`, { status, retryable, retryAfterSeconds });
}

async function call(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new GithubError(`GitHub unreachable: ${err instanceof Error ? err.message : String(err)}`, { retryable: true });
  }
}

/**
 * An installation token that can touch issues of one repository and nothing else, even if the App is
 * later granted more.
 */
export async function getInstallationToken(
  env: GithubBridgeEnv,
  opts: { now?: number; fetchImpl?: typeof fetch; force?: boolean } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const key = `${env.appId}:${env.installationId}:${env.owner}/${env.repo}`;
  if (!opts.force && cached && cached.key === key && cached.expiresAt - 5 * 60_000 > now) return cached.token;

  const res = await call(
    `${API}/app/installations/${env.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt(env.appId, env.privateKey, now)}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repositories: [env.repo], permissions: { issues: "write", metadata: "read" } }),
    },
    opts.fetchImpl ?? fetch,
  );
  const text = await res.text();
  if (!res.ok) throw classify(res.status, res.headers, text);
  const json = JSON.parse(text) as { token: string; expires_at: string };
  cached = { token: json.token, expiresAt: Date.parse(json.expires_at), key };
  return json.token;
}

/** One REST call as the installation. A 401 refreshes the token once (revoked under the cache), then fails. */
export async function githubRequest<T>(
  env: GithubBridgeEnv,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getInstallationToken(env, { fetchImpl, force: attempt > 0 });
    const res = await call(
      `${API}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": USER_AGENT,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      fetchImpl,
    );
    const text = await res.text();
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw classify(res.status, res.headers, text);
    return (text ? JSON.parse(text) : null) as T;
  }
  throw new GithubError("GitHub 401 after a token refresh", { status: 401 });
}
```

`retryable` drives the outbox. GitHub's outage (5xx, 429, a 403 that is a rate limit, a network failure)
is retried; our payload rejected (422) or a repository gone (404) is not, because retrying it six times
changes nothing and keeps a claim slot busy for half an hour.

The token cache is per instance. On Fluid Compute that means one token request per warm instance per
hour, well inside the limits; a shared cache is not worth the coupling.

## The tracker seam

```typescript
// server/bug-reports/tracker.ts
import "server-only";
import type { GithubBridgeEnv } from "@/lib/github/env";
import { parseCommentMarker, parseReportMarker } from "@/lib/bug-reports/tracker-format";
import { githubRequest } from "@/server/github/app";

/**
 * The seam between the outbox and the issue tracker. The jobs and the reconcile pass speak only to this
 * interface; GitHub is the one implementation here, and tests pass a fake.
 */
export type TrackedIssue = { number: number; nodeId: string; url: string };

export type TrackerIssueState = {
  number: number;
  state: string;
  stateReason: string | null;
  body: string | null;
  updatedAt: string;
};

export interface IssueTracker {
  /** `owner/name`, stored on every report so a webhook from another repository never matches. */
  readonly repo: string;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<TrackedIssue>;
  createComment(issueNumber: number, body: string): Promise<{ id: number }>;
  /** Retry de-duplication: an earlier attempt may have created the issue and died before saving it. */
  findIssueByMarker(reportId: string, since: Date): Promise<TrackedIssue | null>;
  findCommentByMarker(issueNumber: number, commentId: string, since: Date): Promise<{ id: number } | null>;
  /** The reconcile backstop: bridged issues updated since the cursor, oldest first. */
  listUpdatedIssues(since: Date): Promise<TrackerIssueState[]>;
}

type GhIssue = {
  number: number;
  node_id: string;
  html_url: string;
  state: string;
  state_reason: string | null;
  body: string | null;
  updated_at: string;
  pull_request?: unknown;
};
type GhComment = { id: number; body: string | null };

/**
 * Markers are found by listing, not by search: GitHub's search does not index HTML comments, so a
 * marker query returns nothing and the retry would open a duplicate.
 */
export function githubTracker(env: GithubBridgeEnv): IssueTracker {
  const base = `/repos/${env.owner}/${env.repo}`;
  const toTracked = (i: GhIssue): TrackedIssue => ({ number: i.number, nodeId: i.node_id, url: i.html_url });
  const list = (params: Record<string, string>) =>
    githubRequest<GhIssue[]>(env, "GET", `${base}/issues?${new URLSearchParams({ labels: env.label, state: "all", per_page: "100", ...params })}`);

  return {
    repo: `${env.owner}/${env.repo}`,

    async createIssue({ title, body, labels }) {
      return toTracked(await githubRequest<GhIssue>(env, "POST", `${base}/issues`, { title, body, labels }));
    },

    async createComment(issueNumber, body) {
      const c = await githubRequest<GhComment>(env, "POST", `${base}/issues/${issueNumber}/comments`, { body });
      return { id: c.id };
    },

    async findIssueByMarker(reportId, since) {
      const issues = await list({ since: since.toISOString(), sort: "created", direction: "desc" });
      const hit = issues.find((i) => !i.pull_request && parseReportMarker(i.body) === reportId);
      return hit ? toTracked(hit) : null;
    },

    async findCommentByMarker(issueNumber, commentId, since) {
      const q = new URLSearchParams({ since: since.toISOString(), per_page: "100" });
      const comments = await githubRequest<GhComment[]>(env, "GET", `${base}/issues/${issueNumber}/comments?${q}`);
      const hit = comments.find((c) => parseCommentMarker(c.body) === commentId);
      return hit ? { id: hit.id } : null;
    },

    async listUpdatedIssues(since) {
      const issues = await list({ since: since.toISOString(), sort: "updated", direction: "asc" });
      return issues
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, state: i.state, stateReason: i.state_reason, body: i.body, updatedAt: i.updated_at }));
    },
  };
}
```

`repo` is stored on every report next to its issue number. The webhook matches on both, so a delivery from
another repository with the same issue number can never touch a report.

Another tracker (Linear, Jira) is another implementation of `IssueTracker` plus a webhook route of its
own. Neither is built here; the interface is the contract an implementation would have to meet.

## What an issue says

```typescript
// lib/bug-reports/tracker-format.ts
import { TRACKER_STRINGS } from "./strings";
import type { ReportContext, ReportStatus } from "./types";

/**
 * Everything that crosses to the tracker and back, as pure functions: what a tenant's text becomes on
 * GitHub, how the app recognises its own issues and comments, and which tracker comments a tenant sees.
 */

/** GitHub refuses an issue or comment body over 65 536 characters. Leave room for the footer. */
export const TRACKER_BODY_LIMIT = 65_536;
const BODY_BUDGET = TRACKER_BODY_LIMIT - 4096;

const REPORT_MARKER = /<!--\s*bug-report:\s*([0-9a-f-]{36})\s*-->/i;
const COMMENT_MARKER = /<!--\s*bug-report-comment:\s*([0-9a-f-]{36})\s*-->/i;

export function reportMarker(reportId: string): string {
  return `<!-- bug-report: ${reportId} -->`;
}

export function commentMarker(commentId: string): string {
  return `<!-- bug-report-comment: ${commentId} -->`;
}

export function parseReportMarker(body: string | null | undefined): string | null {
  return REPORT_MARKER.exec(body ?? "")?.[1]?.toLowerCase() ?? null;
}

export function parseCommentMarker(body: string | null | undefined): string | null {
  return COMMENT_MARKER.exec(body ?? "")?.[1]?.toLowerCase() ?? null;
}

/**
 * Tenant text must not ping people or teams on the tracker: `@name` gets a zero-width space after the
 * `@`, which GitHub does not link. An e-mail address (a word character before the `@`) is left alone.
 */
export function neutralizeMentions(md: string): string {
  return md.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@\u200b");
}

/** HTML comments the tenant typed are dropped, so nobody can forge a marker for another report. */
export function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function truncate(md: string, budget: number): string {
  if (md.length <= budget) return md;
  return `${md.slice(0, budget)}\n\n${TRACKER_STRINGS.truncated}`;
}

/** A table cell: no pipe or newline can break out of its row. */
function cell(value: string | null | undefined): string {
  return (value ?? "-").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "-";
}

function tenantText(md: string): string {
  return truncate(neutralizeMentions(stripComments(md)).trim(), BODY_BUDGET);
}

export type AttachmentLink = { id: string; fileName: string };

export function attachmentUrl(origin: string, attachmentId: string): string {
  return `${origin}/api/bug-reports/attachments/${attachmentId}`;
}

export function issueTitle(tenantName: string, title: string): string {
  return `[${tenantName}] ${title}`.slice(0, 256);
}

export type IssueBodyInput = {
  report: {
    id: string;
    number: number;
    bodyMd: string;
    source: string;
    createdAt: string;
    context: ReportContext;
  };
  tenant: { name: string; slug: string | null };
  reporter: { name: string; roleLabel: string | null };
  attachments: readonly AttachmentLink[];
  /** The origin operators open, never a tenant's own domain. */
  operatorOrigin: string;
  appVersion: string | null;
};

export function renderIssueBody(i: IssueBodyInput): string {
  const s = TRACKER_STRINGS;
  const body = tenantText(i.report.bodyMd) || s.noDescription;
  const ctx = i.report.context;
  const rows: [string, string | null | undefined][] = [
    [s.rowTenant, i.tenant.slug ? `${i.tenant.name} (${i.tenant.slug})` : i.tenant.name],
    [s.rowReport, `#${i.report.number}`],
    [s.rowReporter, i.reporter.roleLabel ? `${i.reporter.name} (${i.reporter.roleLabel})` : i.reporter.name],
    [s.rowSource, i.report.source],
    [s.rowPage, ctx.path],
    [s.rowBrowser, ctx.userAgent],
    [s.rowViewport, ctx.viewport],
    [s.rowTimeZone, ctx.timeZone],
    [s.rowVersion, i.appVersion ? i.appVersion.slice(0, 12) : null],
    [s.rowCreated, i.report.createdAt],
  ];
  const table = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)].join("\n");
  const files = i.attachments.length
    ? `\n\n${s.attachmentsHeading}\n${i.attachments
        .map((a) => `- [${cell(a.fileName)}](${attachmentUrl(i.operatorOrigin, a.id)})`)
        .join("\n")}`
    : "";
  const link = `${i.operatorOrigin}/operator/bug-reports/${i.report.id}`;
  return `${body}\n\n---\n\n${table}${files}\n\n[${s.openInApp}](${link})\n\n${reportMarker(i.report.id)}`;
}

export type CommentBodyInput = {
  commentId: string;
  authorLabel: string;
  bodyMd: string;
  attachments: readonly AttachmentLink[];
  operatorOrigin: string;
};

export function renderCommentBody(i: CommentBodyInput): string {
  const files = i.attachments.length
    ? `\n\n${i.attachments.map((a) => `- [${cell(a.fileName)}](${attachmentUrl(i.operatorOrigin, a.id)})`).join("\n")}`
    : "";
  return `**${cell(i.authorLabel)}:**\n\n${tenantText(i.bodyMd)}${files}\n\n${commentMarker(i.commentId)}`;
}

/** Associations allowed to answer a tenant: never a drive-by account. */
const TEAM_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Whether a tracker comment speaks to the tenant, and what it says. Opt-in: the repository carries the
 * team's own conversation, so a comment is visible only when its first line starts with `/reply` and its
 * author is on the team. A forgotten prefix leaks nothing.
 */
export function parseReplyCommand(
  body: string | null | undefined,
  authorAssociation: string | null | undefined,
): { visible: boolean; body: string } {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const m = /^[ \t]*\/reply(?=\s|$)[ \t]*\n?/i.exec(text);
  if (!m) return { visible: false, body: text };
  if (!authorAssociation || !TEAM_ASSOCIATIONS.has(authorAssociation.toUpperCase())) {
    return { visible: false, body: text };
  }
  const rest = stripComments(text.slice(m[0].length)).trim();
  return { visible: rest.length > 0, body: rest };
}

/** GitHub `state` and `state_reason` to the tenant's status. */
export function mapIssueState(state: string, stateReason: string | null | undefined): ReportStatus {
  if (state !== "closed") return "open";
  if (stateReason === "not_planned") return "not_planned";
  if (stateReason === "duplicate") return "duplicate";
  return "resolved";
}
```

The body is the member's markdown, then a table of what the team needs to reproduce it (tenant, reporter
and role, source, page, browser, viewport, time zone, app version), the attachment links and a link to the
operator view. The marker comes last, as an HTML comment GitHub does not render.

Three things happen to member text before it reaches GitHub:

- **HTML comments are removed**, so nobody can paste a marker that claims another report.
- **Mentions are neutralised** with a zero-width space, so a member cannot ping people or teams.
- **It is cut below GitHub's 65 536-character limit**, with the marker kept intact after the cut.

The issue title is `[Tenant] title`. The team sees at a glance whose report it is; the tenant's own
number is in the table, not the title, because it means nothing in the repository.
