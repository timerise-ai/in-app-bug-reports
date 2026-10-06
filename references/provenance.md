# Provenance

The engineering ledger behind the templates, for the person editing this skill. It keeps three things
apart: what the audit of the earlier implementation changed and how the templates verify it, what was kept
deliberately and why it is safe, and what was designed here and has never run in production.

The earlier implementation was the bug report bridge of a multi-tenant console on Next.js 16, Vercel and
Supabase, with an in-app assistant on the AI SDK: members of any tenant reported bugs with markdown and
screenshots, the reports became issues in the team's code repository through a GitHub App, statuses and
`/reply` comments came back, operators answered from a cross-tenant view, and the assistant drafted
reports behind a confirm card. The architecture, the outbox, the webhook rules, the attachment path, the
notification rules and the draft-tool pattern come from it. Its domain code and its copy stayed in the host
app, where they belong.

Entries 1 and 2 were observed in production logs: the 404s were counted per route and per deployment
before the fix and after it. The others were confirmed by reading the code. Fifteen entries.

## Fixed in the templates

### 1. Vercel Cron could not reach any worker
The proxy resolved the tenant from the host before anything else. Cron calls the deployment's own
`*.vercel.app` host, which no tenant owns, so every cron route in the app, not only this module's, answered
404 from the proxy. Development did not show it: the local seed mapped a `*.vercel.app` wildcard to a test
tenant.
**Shipped:** `CRON_PATHS`, the bypass placed first in the proxy, and a test that the list equals
`vercel.json`, see [outbox.md](outbox.md).

### 2. The webhook host answered "Domain not configured"
The App's webhook pointed at the operator host, which the proxy did not yet treat as a host without a
tenant. Every delivery answered 404 before the route ran.
**Shipped:** a critical fact, an `OPERATOR_ORIGIN` the env reader requires, and a `curl` probe in the
go-live list that tells a proxy 404 from the route's 401, see [webhook.md](webhook.md),
[operations.md](operations.md).

### 3. The text written on GitHub was in the tenants' language
Table labels, link text and comment signatures were hard-coded in the language of the console. The
repository is read by engineers, in the repository's language.
**Shipped:** `TRACKER_STRINGS`, English by default, separate from the members' copy, see
[adaptation.md](adaptation.md).

### 4. Ignored deliveries left no trace
An event from the wrong installation or repository, or for an issue no report owned, answered 200 with the
reason in the body and was otherwise invisible. A misconfigured App looked exactly like a quiet one.
**Shipped:** the reason logged, and written to `bug_report_bridge` for the health view, see
[webhook.md](webhook.md).

### 5. Sign-in from an attachment link lost the file
An anonymous request to an attachment was redirected to sign-in without a return path. Operators open these
links from GitHub, usually before they have a session.
**Shipped:** `loginUrl(returnTo)` in the host seam, called with the attachment's path, see
[attachments.md](attachments.md).

### 6. The lists stopped at a fixed cap
The member list read the newest 200 reports and the operator list the newest 300, with no sign that more
existed.
**Shipped:** keyset pagination on `(last_activity_at, id)` with a cursor in the URL, see
[actions.md](actions.md).

### 7. The worker logic could not be tested
Which deliveries counted, and when a failed job retried, were decided inside functions that also read and
wrote the database.
**Shipped:** `planDelivery` and `decideRetry` as pure functions with their own suites, see
[webhook.md](webhook.md), [outbox.md](outbox.md), [testing.md](testing.md).

### 8. The issue job read the host's members table
The worker looked up the reporter's role in a host table at send time.
**Shipped:** `reporter_role` snapshotted on the report at insert, next to `reporter_name`, so the module
reads no host table at all, see [data-model.md](data-model.md).

## Kept deliberately

### 9. The webhook is processed inline
It looks slower than answering first and working in `after()`. GitHub does not redeliver a failed delivery
by itself, so work after the answer turns every failure into a silent 200. Inline, a failure is a 500 in the
App's log and a Redeliver button; the ledger makes that safe.

### 10. Visibility is opt-in, through `/reply` from the team
It costs the team a prefix on every answer. Every alternative that mirrors by default leaks the team's own
conversation the first time someone forgets a marker.

### 11. No status writer but the tracker
Operators get no close button either. Two writers of one field is how an app and a tracker disagree about
whether a bug is fixed.

### 12. Markers are found by listing, not by search
Listing the label's issues with `since` looks heavier than one search query. GitHub's search does not index
HTML comments, so a search for the marker returns nothing and the retry opens a duplicate.

### 13. No role check for reporting
The person who hits a bug is rarely the person with an admin role. Every member may report and comment,
and the RLS admits any member; a per-member revoke would hide a button the database still serves.

## Added

### 14. A comment waiting for its issue gets its attempt back
In the earlier implementation a comment job waiting for its issue spent attempts like a failing one, so
during an outage it could be parked while its issue was not. `decideRetry` refunds the attempt while the
issue job is pending. Designed here; it has never run in production. See [outbox.md](outbox.md).

### 15. The bridge health view
Last delivery, last ignored delivery and why, last worker run, pending jobs and failed reports, derived
from timestamps the bridge writes. Designed here; the earlier implementation showed only per-report sync
states. See [operations.md](operations.md).

## If you are porting the earlier implementation

Fix order, most damaging first: the cron bypass (1), because it stops every worker in the app; the
operator host (2); the health record (4) and the sign-in return path (5); pagination (6); the attempt
refund (14); then the English tracker strings (3).
