# Operations: the operator view, going live, and when it stops working

## The operator view

Operators are the product team. They are not members of any tenant, they see every tenant's reports, and
they work on `OPERATOR_ORIGIN`, a host the proxy serves without resolving a tenant.

```tsx
// app/operator/bug-reports/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { githubBridgeEnv } from "@/lib/github/env";
import type { SyncState } from "@/lib/bug-reports/types";
import { bugReportsHost } from "@/server/bug-reports/host";
import { bridgeHealth, workerStale } from "@/server/bug-reports/health";
import { listReports } from "@/server/bug-reports/reports";

const SYNC: SyncState[] = ["pending", "synced", "failed", "detached"];

/**
 * Every tenant's reports, failed syncs filterable, and the bridge's pulse above them: whether it is
 * configured, when the tracker last called, why it last ignored a call, and when the worker last ran.
 */
export default async function OperatorBugReportsPage({ searchParams }: { searchParams: Promise<{ status?: string; tenant?: string; sync?: string; cursor?: string }> }) {
  if (!(await bugReportsHost.currentOperator())) notFound();
  const sp = await searchParams;
  const db = bugReportsHost.serviceDb();
  const syncState = SYNC.includes(sp.sync as SyncState) ? (sp.sync as SyncState) : undefined;
  const [page, health] = await Promise.all([
    listReports(db, {
      closed: sp.status === "closed" ? true : sp.status === "all" ? undefined : false,
      tenantId: sp.tenant || undefined,
      syncState,
      cursor: sp.cursor,
    }),
    bridgeHealth(db, githubBridgeEnv() !== null),
  ]);

  return (
    <main>
      <section aria-label="Bridge health">
        <p>Configured: {health.configured ? "yes" : "no: reports wait in the outbox"}</p>
        <p>Worker: {health.lastWorkerAt ?? "never"}{workerStale(health) ? " (stale: check the cron)" : ""}</p>
        <p>Last delivery from GitHub: {health.lastDeliveryAt ?? "never"}</p>
        {health.lastIgnoreReason && (
          <p>
            Last ignored: {health.lastIgnoreReason} at {health.lastIgnoredAt}
          </p>
        )}
        <p>
          Pending jobs: {health.pendingJobs}. Failed reports: <Link href="?sync=failed">{health.failedReports}</Link>
        </p>
      </section>
      <ul>
        {page.items.map((r) => (
          <li key={r.id}>
            <Link href={`/operator/bug-reports/${r.id}`}>
              #{r.number} {r.title}
            </Link>{" "}
            {r.status} {r.syncState} {r.trackerNumber ? `GitHub #${r.trackerNumber}` : ""}
          </li>
        ))}
      </ul>
      {page.nextCursor && <Link href={`?${new URLSearchParams({ ...sp, cursor: page.nextCursor })}`}>Load more</Link>}
    </main>
  );
}
```

```tsx
// app/operator/bug-reports/[id]/page.tsx
import { notFound } from "next/navigation";
import { bugReportsHost } from "@/server/bug-reports/host";
import { getReport } from "@/server/bug-reports/reports";
import { ReportThread } from "@/components/bug-reports/ReportThread";

/** The operator's view of one report: hidden comments, tracker logins, raw context and sync errors included. */
export default async function OperatorBugReportPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await bugReportsHost.currentOperator())) notFound();
  const report = await getReport(bugReportsHost.serviceDb(), (await params).id, { includeHidden: true });
  if (!report) notFound();
  return (
    <main>
      <ReportThread report={report} mode="operator" />
    </main>
  );
}
```

What the view shows that a member's does not: the bridge's health, every tenant, the sync state of each
report with its error, a Retry for a parked one, hidden comments, GitHub logins, the raw context and a link
to the issue. An operator can reply as the team from here; the reply is posted to the issue with a marker
and reaches the members like a `/reply`.

The health line is derived from timestamps the bridge writes as it works, not from a stored status, so a
stopped cron shows as stale instead of looking healthy:

| Shown | Means | Look at |
|---|---|---|
| Configured: no | One of the six variables is missing; reports wait in the outbox | The env of this deployment |
| Worker stale | No worker run in fifteen minutes | The cron list, `CRON_SECRET`, and the proxy bypass |
| Last ignored: `installation` or `repository` | The App sends events for something this deployment does not serve | The installation id and repository variables |
| Last ignored: `unknown_issue:<n>` | An event for an issue no report owns: a labelled issue made by hand, or a report on another deployment | Usually nothing |
| Failed reports | Jobs parked after six tries, or rejected | The error on the report, then Retry |

## Going live

1. Register the App and set the variables, see github-app.md. One App per project; a second App for
   preview, with `GITHUB_REPORTS_LABEL=tenant-report-preview`, so preview reports never mix with real ones.
2. Apply the migration and the two `app` functions.
3. Add the cron path to `vercel.json` **and** to `CRON_PATHS`; deploy.
4. Probe the routes from outside, after the deployment:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" "https://<deployment>.vercel.app/api/bug-reports/worker"  # 401, not 404
   curl -s -X POST "$OPERATOR_ORIGIN/api/github/webhook"                                             # Invalid signature, 401
   ```
   A 404 on either is the proxy, not the route: see the failure table.
5. In the App's settings, Advanced, redeliver the `ping`: 200.
6. File a report with a screenshot. The issue appears with the label within seconds, and the thread loses
   its "passing it to the team" line.
7. Comment on the issue without `/reply`: nothing in the app. Comment `/reply Thanks`: it appears in the
   thread as the team, and the reporter is notified.
8. Close the issue as not planned: the report reads "Not planned".
9. Open an attachment link from the issue in a private window: sign-in, then the file.

## When it stops working

| Symptom | Cause | Fix |
|---|---|---|
| Every worker in the app answers 404, not only this one | Cron calls `*.vercel.app`; the proxy resolved no tenant | The proxy bypass and `CRON_PATHS`, see outbox.md |
| Deliveries answer 404 "Domain not configured" | The operator host is not one the proxy serves without a tenant | Configure the host as the operator host; probe with the `curl` above |
| Deliveries answer 401 | `GITHUB_WEBHOOK_SECRET` differs from the App's | Make them equal, redeploy, redeliver |
| Deliveries answer 503 | No secret, or the App variables are incomplete | Set them and redeploy |
| Reports stay "passing it to the team" | The worker returns `not_configured`, or it never runs | The variables; then the worker line on the health view |
| A report shows sync failed | A rejected issue (422), a revoked installation, a deleted repository | Fix the cause, then Retry |
| A status never changed | The delivery failed or never came | Redeliver it; reconcile also re-applies it within five minutes |
| A `/reply` never appeared | The delivery failed, the prefix was not on the first line, or the author is not on the team | Redeliver; check the comment's association |
| An issue was deleted or moved | The report is detached | Nothing to fix; reply from the operator view if needed |
| Duplicate issues for one report | The marker search could not see the first issue | The label: the search lists by label, so a label removed by hand hides the issue |

Redelivery is always safe. The ledger turns a second delivery of the same id into a replay, and every write
the webhook makes is conditional on the state it changes.

## Credentials

- **The private key**: generate a new one in the App, deploy it, then delete the old one in the App. Both
  work in between.
- **The webhook secret**: change it in the App and in the environment together; deliveries in between
  answer 401 and can be redelivered once both match.
- **The installation**: removing the App from the repository parks every job with a 404. Reinstall, set the
  new installation id, then Retry the failed reports.

## Privacy

Report text and the reporter's name and role go to GitHub; e-mail addresses never do. The repository must
be private, GitHub becomes a processor of that text, and the processor register and the privacy notice say
so. Attachments stay in the app's own storage, in the app's region.
