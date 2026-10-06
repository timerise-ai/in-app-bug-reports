# Testing: what the suites prove

Nine suites, 49 tests, all on pure logic or on the GitHub client with a fake `fetch`. They live in
`assets/tests/` and are copied into the generated app at the paths on their first lines.

| Suite | Tests | Proves |
|---|---|---|
| `lib/bug-reports/tracker-format.test.ts` | 15 | Markers round-trip; a typed marker is dropped; table cells cannot break; the body stays under 65 536 with the marker; mentions are neutralised; `/reply` is opt-in, prefix-exact, first-line only and team-only; `state_reason` maps to the right status; titles cap at 256 |
| `lib/bug-reports/webhook-plan.test.ts` | 7 | Foreign installations and repositories are flagged; pull requests are ignored; close, reopen, delete and transfer plan correctly; the App's own comments are echoes by marker and by App id; team `/reply` is visible and the rest is not |
| `lib/bug-reports/retry.test.ts` | 5 | Outages retry until the budget, then park; our errors park at once; a longer `Retry-After` is honoured; a comment waiting for its issue gets its attempt back |
| `lib/bug-reports/notification-copy.test.ts` | 4 | Titles stand alone; replies are quoted; recipients are the reporter and commenters once each, never the actor |
| `lib/bug-reports/strings.test.ts` | 2 | Every status and every action error code has copy |
| `lib/github/signature.test.ts` | 3 | GitHub's signature verifies; other bodies, secrets and missing parts do not; a truncated or multi-byte header returns false instead of throwing |
| `lib/github/env.test.ts` | 4 | Any missing variable means unconfigured; the key's newlines and the origin's slash are fixed; the label defaults |
| `lib/cron-paths.test.ts` | 2 | `CRON_PATHS` equals the crons in `vercel.json`; nothing next to a path matches |
| `server/github/app.test.ts` | 7 | The JWT is RS256, from the App, backdated, under ten minutes, and verifies; the token is narrowed and cached and refreshed near expiry; a 401 retries once with a new token; outages are retryable and our errors are not |

## Wiring them

They are written for vitest. The GitHub client imports `server-only`, which throws outside a React Server
environment, so the test config aliases it to an empty module:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: { include: ["**/*.test.ts"], exclude: ["node_modules/**"] },
});
```

```typescript
// test/server-only.ts
export {};
```

`cron-paths.test.ts` reads `vercel.json` from the working directory, so run the suite from the app root.
Under `bun test` the only change is the import line in each file.

## What is not covered by these suites

Stated rather than implied:

- **The SQL** was applied to an empty Postgres with stub `tenants`, `members` and `app` functions and
  exercised as the `authenticated` role; data-model.md lists the checks. It is not run by these suites.
- **The server modules, routes, actions and components** type-check under `strict` and
  `noUncheckedIndexedAccess` with `next` 16, `ai` 7, `zod` 4 and `@supabase/supabase-js` 2, but are not
  exercised here: they need a database and a session.
- **The two fragments** in assistant-tool.md (the chat route and the message parts) depend on the host's
  code and are not compiled.
- **Nothing here talks to GitHub.** The go-live list in operations.md is the end-to-end pass.

## An integration test worth adding

Against a local database, with a fake `IssueTracker` passed to `processDueJobs({ tracker, db, env })` and
the plan fed to `processDelivery(env, event, id, payload, db)`:

- a GitHub outage on the first try, then success, opens exactly one issue;
- a comment job claimed with its issue job waits, then posts once;
- a close delivered twice changes the status once and notifies once;
- an internal comment is not mirrored, a `/reply` is, and editing out the prefix hides it;
- the App's echo of a member's comment fills in its id and creates no second comment.

Give the fake tracker issue numbers from one counter shared by every test: GitHub never reuses a number in
a repository, and a fake that does makes two reports collide on `unique (tracker_repo, tracker_number)`.
