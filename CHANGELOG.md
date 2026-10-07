# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-10-07

Fix release, from scoring the prompt-1 agent eval runs against 0.1.2.

### Fixed

- The upload picker (attachments.md) ends a thrown upload in an error. With no `catch`, an unreachable
  action or a `createBrowserClient` missing its `NEXT_PUBLIC_` config left the file "uploading" and the form
  could never send. Apps built from earlier versions add the `.catch(...)` to the upload block.
- `MarkdownField` (member-ui.md) takes a `label` for its textarea, which had no accessible name; the
  new-report form now has its `newTitle` heading.

### Changed

- github-app.md and `SKILL.md`: the `NEXT_PUBLIC_` values are inlined at build, not required at build;
  the picker reads them as shipped, with no config route.
- outbox.md, `SKILL.md`, README: `/api/github/webhook` beside `isCronPath` in the proxy bypass is a
  documented harmless addition, never in `CRON_PATHS`.

## [0.1.2] - 2026-10-07

Fix release, from scoring the prompt-1 agent eval runs against 0.1.1.

### Fixed

- `findIssueByMarker` and `findCommentByMarker` (github-app.md) page until a short page. They read only the
  first 100, so a retry after more than a hundred newer labelled issues, or on an issue with more than a
  hundred comments, missed its marker and opened a duplicate. Apps built from 0.1.0 or 0.1.1 copy the two
  methods from `server/bug-reports/tracker.ts`. A new test in `server/github/app.test.ts`: 50 tests.

### Changed

- `SKILL.md`: the cron bypass is the block in outbox.md as written and admits nothing else, and a
  template is neither trimmed nor extended.
- adaptation.md: the member and operator pages build as static 404s until `host.ts` reads the session,
  which needs no `dynamic` export.

## [0.1.1] - 2026-10-07

Fix release, from scoring the prompt-1 agent eval runs against 0.1.0.

### Fixed

- `vitest.config.ts` (testing.md) now excludes `.*/**`. With the skill installed inside the project, as
  `npx skills add` does, vitest collected the skill's own copies of the suites and `npm test` failed. Apps
  built from 0.1.0 add `".*/**"` to `test.exclude`.
- github-app.md: `OPERATOR_ORIGIN` is now among the "first six" variables that switch the bridge on, as
  `lib/github/env.ts` already required; the optional label had taken its place in the table.

### Changed

- The quick start in `SKILL.md` and adaptation.md name every dependency, `server-only` included, say the
  package registry is not an external service, and forbid replacing a dependency with hand-written code.
- The suites run unmodified under vitest; testing.md no longer offers a port to `bun test`.
- github-app.md lists all eleven variables the module reads as an `.env.example` block.
- outbox.md: the cron bypass is copied with its header strip and admits nothing else.
- `SKILL.md` ends the quick start with what the operator must be told.

## [0.1.0] - 2026-10-06

First release: an in-app bug report module for Next.js App Router apps, bridged to
GitHub Issues, with an assistant tool that drafts reports.

### Added

- The data model: reports, comments and attachments under insert-only RLS, a
  per-tenant number, an outbox, a webhook ledger, a bridge health row and a
  private bucket.
- The GitHub side: App registration, a JWT and installation-token client with no
  SDK, the `IssueTracker` seam, and the issue and comment bodies.
- The outbox with marker de-duplication, a pure retry policy, reconcile, the cron
  route and the proxy bypass for cron paths.
- The webhook: signature, a pure delivery plan, `/reply` visibility, echoes,
  and inline processing with a ledger.
- Attachments by signed upload, claimed on save and read through a sign-in route.
- Read models with keyset pages, member and operator actions, the member screens,
  notifications, the operator view with bridge health, and the draft tool.
- Nine vitest suites, 49 tests.
