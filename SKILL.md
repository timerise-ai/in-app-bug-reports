---
name: in-app-bug-reports
description: >
  Build an in-app bug report module in a Next.js App Router app that files every report as a GitHub
  issue: members of any tenant report with a title, markdown and attachments, the issue's state comes
  back as the report's status, the team answers with /reply comments, operators see every tenant, and
  an AI assistant tool drafts a report that the member sends. Use when: (1) adding a "report a bug" or
  "send feedback" button whose reports land in GitHub Issues, (2) mirroring issue status and replies
  back into the app, (3) letting an assistant draft a bug report without letting it send one, (4) an
  existing bridge loses reports, opens duplicate issues, leaks internal comments or never updates
  status, (5) the user mentions: bug report, report a bug, feedback button, GitHub Issues
  integration, GitHub App, installation token, X-Hub-Signature-256, issue webhook, issue_comment,
  state_reason, not_planned, /reply, outbox, Vercel Cron 404, "Domain not configured" on a webhook,
  signed upload URL, createSignedUploadUrl, private attachments, draft tool, needs approval. Carries
  an outbox with marker de-duplication, the webhook rules that keep the team's conversation private,
  login-gated attachments that never become public URLs, cron and webhook routes that a multi-tenant
  proxy serves without a tenant, and 50 tests. Next.js App Router with Postgres and Supabase RLS; the host
  seam is one BugReportsHost object and a client UI module, and the tracker sits behind IssueTracker.
  Not error monitoring, not a help center and not a support inbox.
---

# In-app bug reports bridged to GitHub Issues

Any member of any tenant reports a bug from inside the app; the product team works it in GitHub
Issues; the member sees the status and the team's replies without leaving the app.

The idea the design turns on: **the local row is the record, the tracker follows it, and the tracker
owns the status.** A report is saved under the tenant's policies first and reaches GitHub through an
outbox, so a GitHub outage delays it and loses nothing. Status is written only from GitHub's own
state, so the app and the tracker can never disagree about whether a bug is fixed.

Written by the engineer who has shipped this module, audited against the earlier implementation, the bug
report bridge of a multi-tenant console on Next.js 16, Vercel and Supabase. The templates hold what
such a bridge must: one issue per report however often a job retries, no team comment shown to a tenant
without an explicit opt-in, no attachment reachable without a sign-in, and workers that run on any host.
[provenance.md](references/provenance.md) has the record.

## When to use

- A product wants its users to report bugs from inside the app, into the repository the team uses.
- The team wants to answer and close reports in GitHub and have the app reflect it.
- An assistant in the app should help write a report without being able to send one.

## When NOT to use

- **Crash and exception capture**: an error monitoring service. This module files what a person writes.
- **Help articles and search**: the `help-center-markdown` skill; link its pages to this form.
- **Customer support conversations**: a support inbox. Reports here go to engineers, not to agents.
- **Assistants in Slack**: the `slack-ai-bot` skill, which carries its own approval round trip.

## Architecture

```
  member ---> /bug-reports/new ---> createReport ---> bug_reports (RLS, insert only)
                |  files: prepareUpload -> signed URL -> private bucket -> claimed on save
                v
             bug_report_jobs (outbox) <--- after() now, cron every 5 min --- processDueJobs
                |  create_issue / post_comment, marker de-dup on retry
                v
           GitHub App (installation token: one repo, issues only) ---> issue #123
                                                                         |
  member <--- notifications <--- applyStatus / mirror /reply <--- POST /api/github/webhook
                                     ^                                (HMAC, ledger, inline)
                                     +--- reconcileStatuses (cron backstop, cursor)
  operator ---> /operator/bug-reports: every tenant, bridge health, retry, reply as the team
  assistant ---> draft_bug_report (reads nothing, writes nothing) ---> card ---> createReport
```

## Critical facts

1. **Vercel Cron calls the deployment's own `*.vercel.app` host.** A proxy that resolves the tenant
   from the host answers every cron 404, and no worker ever runs. List the cron paths in
   `CRON_PATHS` and pass them before tenant resolution with the block in outbox.md as written, and
   nothing else through it; the test keeps the list equal to `vercel.json`.
2. **The webhook URL must be a host the proxy serves without a tenant.** On a tenant-resolving proxy
   an unconfigured operator host answers "Domain not configured" and GitHub's deliveries all 404.
3. **GitHub does not redeliver a failed webhook by itself.** Process the delivery inline and answer
   500 on failure, so it shows in the App's delivery log; the ledger makes "Redeliver" safe.
4. **Search does not index HTML comments.** Find a report's marker by listing the label's issues;
   a search for the marker returns nothing and the retry opens a duplicate.
5. **`state_reason` is what says resolved.** `closed` plus `not_planned` or `duplicate` is not a fix.
6. **A Server Action body stops at 1 MB.** Files go from the browser to a signed upload URL; the
   action only reserves a row and later claims it, after checking the object really landed.
7. **GitHub's image proxy cannot fetch a login-gated URL.** Attachments are links, not inline images.
8. **An ignored delivery still answers 200**, or GitHub marks the hook failing. Record why it was
   ignored, so a misconfigured installation shows on the health view instead of looking healthy.
9. **The installation token is requested narrowed** to one repository and to issues, so it cannot
   touch code even if the App is later granted more.

## Hard rules

> **Never let the app write a status.** No UPDATE policy for members, no close button for anyone.
> GitHub's state is the only writer, through the webhook and the reconcile pass.

> **Never show a tracker comment to a tenant unless it opts in.** A comment is visible only when its
> first line starts with `/reply` and its author is on the team. Mirroring everything except an
> `/internal` marker leaks the first time someone forgets it.

> **Never call the tracker inside the request that saves the report.** Save, enqueue, return; the
> outbox sends. A report refused because GitHub is down is a report lost.

> **Never publish an attachment.** Private bucket, a 404 for everyone but an operator or the
> report's tenant, a 60-second signed URL, no SVG or HTML.

> **Never let the assistant send.** The draft tool reads nothing and writes nothing; the member's
> click on the card runs the same Server Action as the form.

## Quick start

Copy each code block verbatim to the path on its first line. You write `server/bug-reports/host.ts`
bodies, `components/bug-reports/host-ui.tsx`, the two SQL functions in adaptation.md, the renames
and the strings. A template that looks redundant is not trimmed: provenance.md says why it is there.
Nor is one extended: no polling, no `dynamic` export, no config route for the `NEXT_PUBLIC_` values,
no check or retry it does not ship.
Install what the host lacks of `zod`, `@supabase/supabase-js`, `@supabase/ssr`, `server-only` and
`vitest` (`ai` only with an assistant) with its package manager. The package registry is not an
external service, and no dependency is replaced by hand-written code or dropped from a template.

1. Probe the host and fill in the seams, see [adaptation.md](references/adaptation.md).
2. Create the tables, policies, outbox and bucket, see [data-model.md](references/data-model.md).
3. Add the client, the tracker and `.env.example` with all eleven names, see [github-app.md](references/github-app.md).
4. Add the outbox, the worker, the cron and the proxy bypass, see [outbox.md](references/outbox.md).
5. Add the webhook, see [webhook.md](references/webhook.md).
6. Add uploads and the attachment route, see [attachments.md](references/attachments.md).
7. Add the read models and the actions, see [actions.md](references/actions.md).
8. Build the form, the list and the thread, see [member-ui.md](references/member-ui.md).
9. Wire the notifications, see [notifications.md](references/notifications.md).
10. Add the assistant's draft tool, see [assistant-tool.md](references/assistant-tool.md).
11. Run the nine suites unmodified under vitest, reporting 50, see [testing.md](references/testing.md).
12. Add the operator view and walk the go-live list, see [operations.md](references/operations.md).

End by telling the operator three things: the bridge is off, and reports are saved and wait, until the
first six variables in github-app.md are set; the migration, the two `app` functions and the GitHub App are theirs to
apply and register; and while `currentMember` and `currentOperator` answer null, every page is a 404.

## Reference directory

| Scenario | Trigger keywords | Reference |
|---|---|---|
| Fitting it to a host app | seam, BugReportsHost, host.ts, host-ui, rename, tenant, member, operator, i18n, strings | [adaptation.md](references/adaptation.md) |
| Tables and policies | bug_reports, RLS, insert only, per-tenant number, advisory lock, outbox, bucket | [data-model.md](references/data-model.md) |
| The GitHub side | GitHub App, env, .env.example, JWT, RS256, installation token, 401, 422, 429, rate limit, IssueTracker, marker, issue body | [github-app.md](references/github-app.md) |
| Sending and retrying | outbox, claim, lease, MAX_ATTEMPTS, duplicate issue, reconcile, cursor, Vercel Cron, 404, proxy, CRON_PATHS | [outbox.md](references/outbox.md) |
| Hearing back | webhook, X-Hub-Signature-256, ping, X-GitHub-Delivery, redelivery, state_reason, /reply, echo, Domain not configured | [webhook.md](references/webhook.md) |
| Files | upload, 1 MB, createSignedUploadUrl, uploadToSignedUrl, paste screenshot, signed URL, 404 not 403, SVG | [attachments.md](references/attachments.md) |
| Reads and writes | Server Action, ActionResult, keyset pagination, cursor, rate limit, createReport, addComment, retrySync | [actions.md](references/actions.md) |
| The screens | form, markdown preview, list, thread, help page button, Not a menu section, privacy hint | [member-ui.md](references/member-ui.md) |
| Telling people | bell, push, notifyMembers, tag, mark read, reporter, commenters | [notifications.md](references/notifications.md) |
| The assistant | draft_bug_report, AI SDK tool, tool part, output-available, confirm card, sessionStorage, prompt injection | [assistant-tool.md](references/assistant-tool.md) |
| Proving it | vitest, tests, npm test, exclude, server-only stub, fake tracker, integration | [testing.md](references/testing.md) |
| Running it | setup, env, preview label, one App per project, health, stale worker, failed sync, rotate key | [operations.md](references/operations.md) |
| What the audit changed | audit, fixed, kept deliberately, added, fix order | [provenance.md](references/provenance.md) |

Part of the [Timerise Skills](https://github.com/timerise-ai/skills) index, which lists the sibling skills.
