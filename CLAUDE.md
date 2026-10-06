# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

An [Agent Skill](https://agentskills.io) package: markdown only, plus test files under `assets/tests/`.
There is no `package.json` here and nothing in this repository executes. It teaches an agent to build an
in-app bug report module inside a **Next.js App Router** app: members of any tenant report with markdown and
attachments, each report becomes a GitHub issue through a GitHub App and an outbox, the issue's state and the
team's `/reply` comments come back through a webhook, operators see every tenant, and an assistant tool
drafts reports that the member sends.

Keep the two straight: the commands and code in `references/` describe the app the agent will generate, not
this repository. The SQL in `data-model.md` and `adaptation.md`, the `curl` probes in `webhook.md` and
`operations.md`, the host probe in `adaptation.md` and the vitest config in `testing.md` all run in that
generated app. The one thing checked here is that the templates compile and the suites pass, and that check
runs in a scratch project; the recipe is under *Editing conventions* below.

The skill was written by the engineer who has shipped this module; the earlier implementation it was audited
against was the bug report bridge of a multi-tenant console on Next.js 16, Vercel and Supabase.
`references/provenance.md` is the ledger of that audit: fifteen entries on what changed and how the templates
verify it, what was kept deliberately, and what was designed here and has never run in production. That file
is the rationale layer: read it before "simplifying" anything.

## Structure

- `SKILL.md`: entry point, loaded whole on every activation, so it stays between 130 and 160 lines, the
  closing index line aside. The frontmatter `description` is the trigger surface; the body carries the
  architecture diagram, nine **critical facts**, five **hard rules**, the quick-start order, the **reference
  directory table** mapping trigger keywords to files, and a closing line linking the skills index.
- `README.md`: the human-facing front door, in the section order of the skill standard: install, activation,
  the file table, the five non-negotiables, requirements, security, verification, the *Not this* table,
  contributing.
- `references/*.md`: one topic per file, loaded on demand. `adaptation.md` (the seams) and `data-model.md`
  (the tables and policies) are the design entry points; `github-app.md`, `outbox.md` and `webhook.md` carry
  the bridge; `attachments.md`, `actions.md` and `member-ui.md` the app side; `notifications.md` and
  `assistant-tool.md` the two integrations; `operations.md` the operator surface; `testing.md` the suites;
  `provenance.md` the audit.
- `assets/tests/`: the nine suites, each at the path on its first line in the generated app.
- `evals/`: `prompts.md` holds what an operator types after installing, in their words; the first prompt
  is the agent eval run before every release. Every other file there is one eval run: measured frontmatter
  that is never edited, then the notes of the person who ran it. Add a prompt rather than rewording one that
  has results. The procedure is section 10 of the index's STANDARD.md.
- `.github/workflows/agent-eval.yml`: the caller of the index's reusable eval workflow, run on every
  published release and on a maintainer's dispatch. It is copied verbatim from the index's STANDARD.md and
  is the same in every skill; do not edit it, and never add a trigger on `push` or `pull_request`.

## Editing conventions

- **Code blocks name their destination on the first line** as a comment, for example
  `// server/bug-reports/jobs.ts`. That line is what lets a block be written to its file, so keep it and keep
  imports complete. The SQL blocks name theirs with `--`.
- **The code blocks are compiled and run.** The TypeScript and TSX blocks across the references form one
  project: write each to the path on its first line in a scratch directory, add `vercel.json` with the one
  cron from `outbox.md`, copy the contents of `assets/tests/` to the scratch root (each suite's first line is
  its path from the app root, e.g. `lib/github/env.test.ts`), install `next`, `react`, `@types/react`,
  `@types/node`, `ai`, `zod`, `@supabase/supabase-js`, `@supabase/ssr`, `vitest` and `typescript`, then

  ```bash
  npx tsc --noEmit    # strict, noUncheckedIndexedAccess, skipLibCheck, jsx react-jsx, paths {"@/*": ["./*"]}
  npx vitest run      # 49 tests, with the server-only alias from testing.md
  npx vitest run lib/github/env.test.ts   # one suite
  ```

  `vitest.config.ts` and `test/server-only.ts` are themselves blocks in `testing.md`, written in the same
  pass. Run from the scratch root: `cron-paths.test.ts` reads `vercel.json` from the working directory.

  `skipLibCheck` is not optional, or Next's own declarations fail the run and say nothing about these
  templates. The proxy block in `outbox.md` compiles as a file of its own. The two fragments in
  `assistant-tool.md` are marked as fragments and stay outside the project. The SQL is checked against
  Postgres as `data-model.md` describes.
- **Identifiers are shared across files.** `BugReportsHost`, `bugReportsHost`, `Member`, `Operator`,
  `MemberNotice`, `AuditEntry`, `Report`, `ReportComment`, `ReportAttachment`, `ReportStatus`, `SyncState`,
  `REPORT_LIMITS`, `REPORT_DRAFT_STORAGE_KEY`, `ActionResult`, `ActionErrorCode`, `GithubBridgeEnv`,
  `githubBridgeEnv`, `GithubError`, `IssueTracker`, `githubTracker`, `planDelivery`, `DeliveryPlan`,
  `decideRetry`, `MAX_ATTEMPTS`, `enqueueJob`, `runJob`, `processDueJobs`, `reconcileStatuses`,
  `processDelivery`, `applyStatus`, `reserveUpload`, `claimAttachments`, `signedAttachmentUrl`,
  `listReports`, `getReport`, `createReport`, `addComment`, `markReportRead`, `replyAsOperator`,
  `retrySync`, `notifyFollowers`, `reportNotice`, `noticeRecipients`, `draftBugReportTool`,
  `DRAFT_TOOL_NAME`, `DRAFT_TOOL_PROMPT_RULE`, `parseDraftOutput`, `CRON_PATHS`, `isCronPath`,
  `TRACKER_STRINGS`, `NOTICE_STRINGS`, `consoleKeys`, and the env names `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_REPORTS_REPO`, `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_REPORTS_LABEL`, `OPERATOR_ORIGIN`, `CRON_SECRET` appear in several references. Rename in all of
  them or none.
- **Keep the three tables in sync** with `references/`: the reference directory in `SKILL.md`, the quick-start
  list in `SKILL.md`, and the file table in `README.md`. Links are relative: `[x.md](references/x.md)` from
  `SKILL.md`, `[x.md](x.md)` between references.
- **Do not remove the odd-looking parts.** The webhook processed inline rather than in `after()`; markers
  found by listing rather than search; the insert policies that pin status and tracker columns; the `exists`
  check in the comment policy; `revoke update, delete`; the `security definer` numbering trigger; the
  `neq` in the status update; the attempt refund for a comment waiting for its issue; the claim that checks
  the object's size and type; 404 rather than 403; the cron bypass placed first in the proxy; ignored
  deliveries answered 200 and recorded. Each is a ledger entry or a documented judgement call. Check
  `provenance.md` before touching one.
- **The numbers that remain are load-bearing.** 49 tests in nine suites, fifteen ledger entries, GitHub's
  own limits (65 536 characters in a body, 256 in a title, a ten-minute App JWT, a ten-second webhook
  budget), and the design parameters (six attempts, a five-minute lease and cron, a 60-second wait for an
  issue, ten reports an hour, ten files, 10 MB and 25 MB caps, a 60-second signed URL, fifty a page, a
  fifteen-minute stale worker). Do not restate them loosely and do not add new ones. The test count is
  repeated in the `SKILL.md` description and quick-start step 11, three places in `README.md`,
  `testing.md`'s opening line and `CHANGELOG.md`; a change to the suites updates all of them. Figures
  describing the earlier implementation's deployment do not appear anywhere.
- **Mark additions as additions.** Anything designed in the skill and never run in the earlier
  implementation belongs in the "Added" section of `provenance.md`, stated as such.
- **Releases.** Commits follow Conventional Commits; releases follow the index's STANDARD.md. A release adds
  a `CHANGELOG.md` section (Keep a Changelog, SemVer) and updates "The current release is **x.y.z**" in
  `README.md`'s install section, which nothing else keeps in step.
- **Evals are not skill content.** A new prompt or an eval result is committed as `chore(evals): ...`,
  never causes a version bump and never rides in a release commit.
- **Never present the non-negotiables as optional.** The tracker as the only status writer, `/reply` as
  the only way a comment reaches a tenant, the outbox between the request and the tracker, the private
  attachment, and the draft that only a member sends are hard rules in `SKILL.md` and non-negotiables in
  `README.md`; keep them that way everywhere.
- **Which names the host renames**, and which are the authoring contract: tenant, member, operator and
  report, with their tables, routes and types, are canonical vocabulary the host renames, and
  `adaptation.md` carries that table; every string in `consoleKeys` and `NOTICE_STRINGS` is the host's too.
  GitHub's terms, the env names, the marker text and the `IssueTracker` and `BugReportsHost` method names
  are the contract and are not renamed.
- **The prose is plain ASCII.** No em-dashes, arrows, middle dots or smart quotes, including in the diagram,
  which is drawn with `-`, `|`, `+`, `>`, `<`, `v` and `^`.
