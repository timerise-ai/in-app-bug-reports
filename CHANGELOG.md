# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
