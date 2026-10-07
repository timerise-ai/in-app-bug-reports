# in-app-bug-reports

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-open_format-059669)](https://agentskills.io)
[![skills.sh](https://img.shields.io/badge/skills.sh-npx_skills_add-059669)](https://www.skills.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-059669)](https://docs.claude.com/en/docs/claude-code/skills)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-compatible-059669)](https://developers.openai.com/codex/skills)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-compatible-059669)](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md)

An [Agent Skill](https://agentskills.io) that teaches an agent to build an in-app bug report module in a
**Next.js App Router** app, bridged to GitHub Issues. Members of any tenant report a bug with a title, a
markdown description and screenshots; each report becomes an issue in the team's repository through a
GitHub App; the issue's state comes back as the report's status and the team's `/reply` comments come back
as replies. Operators see every tenant's reports in one view, and an in-app assistant can draft a report
that the member then sends.

**The local row is the record, the tracker follows it, and the tracker owns the status.** A report is saved
under the tenant's own policies first and reaches GitHub through an outbox, so a GitHub outage delays it
and loses nothing. The status is written only from GitHub's state, so the app and the tracker never
disagree about whether a bug is fixed. Everything else follows from those two lines: idempotent jobs, a
webhook that applies rather than decides, and a member who can insert but never update.

This skill was written by the engineer who has shipped this module. The earlier implementation it was
audited against was the bug report bridge of a multi-tenant console on Next.js 16, Vercel and Supabase,
with an assistant on the AI SDK. The templates hold the properties such a bridge has to hold: one issue per
report however often a job retries, no team comment shown to a tenant without an explicit `/reply`, no
attachment reachable without a sign-in, workers and the webhook reachable on a multi-tenant proxy, and an
assistant that drafts but cannot send. The suites in [`references/testing.md`](references/testing.md)
state each one; [`references/provenance.md`](references/provenance.md) has the record.

## Install

One command, via the [skills.sh](https://www.skills.sh) CLI, which installs the skill into every
skills-compatible agent it detects, including Claude Code, Codex CLI and Gemini CLI:

```bash
npx skills add timerise-ai/in-app-bug-reports
```

Name the agents instead with `-a`, for example
`npx skills add timerise-ai/in-app-bug-reports -a claude-code -a codex`.

### Manual install

Nothing here is Claude-specific: the skill is a plain [Agent Skills](https://agentskills.io) folder,
`SKILL.md` plus markdown references with no file that calls a model, so cloning it into an agent's skills
directory is all an install is. For Claude Code:

```bash
git clone https://github.com/timerise-ai/in-app-bug-reports.git ~/.claude/skills/in-app-bug-reports
```

To scope it to a single project instead, clone it into that project's `.claude/skills/` directory. For another
agent, clone into that agent's skills directory, or symlink the Claude Code copy so one `git pull` updates
every agent:

```bash
mkdir -p ~/.agents/skills
ln -s ~/.claude/skills/in-app-bug-reports ~/.agents/skills/in-app-bug-reports
```

Update the skill with `git pull` in its directory. The current release is **0.1.0**. See
[CHANGELOG.md](CHANGELOG.md). The [skills index](https://github.com/timerise-ai/skills) lists the other
Timerise Skills and how to install them all at once.

## Activation

The skill activates automatically when a task matches its description: adding a "report a bug" or "send
feedback" button whose reports land in GitHub Issues, mirroring issue status and replies back into the app,
letting an assistant draft a report, or debugging a bridge that opens duplicate issues, shows the team's
internal comments, or never updates a status. Invoke it explicitly with `/in-app-bug-reports` in Claude
Code, `$in-app-bug-reports` in Codex CLI, or from `/skills` in Gemini CLI.

Each host matches a task against the description its own way, so invoke the skill explicitly on a first run
rather than assuming it fired. Only `SKILL.md` is read up front; the `references/` files load on demand, so
the skill stays cheap in context until a topic is actually needed.

## What's inside

| File | Contents |
|---|---|
| `SKILL.md` | Entry point: architecture diagram, critical facts, hard rules, quick start, and the reference directory |
| `README.md` | This file |
| `CHANGELOG.md` | One section per release, newest first |
| `CLAUDE.md` | The editing conventions, for an agent editing this repository |
| `LICENSE` | MIT |
| `references/adaptation.md` | The seam contract: `BugReportsHost`, the client UI module, the two SQL functions, the strings, the rename table, other backends |
| `references/data-model.md` | The types, the migration with its policies, numbering trigger, outbox, ledger, bridge row and bucket, and the checks it was put through |
| `references/github-app.md` | Registering the App, the environment and `.env.example`, the JWT and token client, the `IssueTracker` seam, what an issue says |
| `references/outbox.md` | The retry policy, the two jobs, the worker and reconcile, the health record, the cron route and the proxy bypass |
| `references/webhook.md` | Signature, the delivery plan and its table, the visibility rule, echoes, applying it, the route and its host |
| `references/attachments.md` | Reserve, upload, claim, read and sweep; the sign-in route; the browser picker |
| `references/actions.md` | The read models with keyset pages, the member actions, the operator actions |
| `references/member-ui.md` | Entry points, the markdown field, the form, the list and the thread |
| `references/notifications.md` | Who is told what, one notice per report, sending and marking read |
| `references/assistant-tool.md` | The draft-tool pattern, the tool, registering it, the confirm card |
| `references/operations.md` | The operator view and its health line, the go-live list, the failure table, credentials, privacy |
| `references/testing.md` | The nine suites, 49 tests, how to wire them, what they do not cover, an integration test worth adding |
| `references/provenance.md` | The engineering ledger: what the audit changed and how the templates verify it, what was kept on purpose, and what is new in the skill |
| `assets/tests/` | The nine suites as files, at the paths on their first lines |
| `evals/` | The prompts an operator types after installing (`prompts.md`) and one file per agent eval: the skill installed into an empty Next.js app, one prompt, no help, then type-checked, built and tested |
| `.github/workflows/agent-eval.yml` | The caller of the index's reusable eval workflow, run on every published release and on a maintainer's dispatch |

The seam is the contract table at the top of `references/adaptation.md`: one server object,
`BugReportsHost`, one client module, `host-ui.tsx`, and two SQL functions the policies call. It bounds who
is a member and who is an operator, the two database clients, the tenant's name, the notification feed, the
audit log, the sign-in route, the markdown renderer and the strings. Everything above it is the skill's;
everything below it is the host app's, including auth, tenancy, styling and i18n. The tracker is a second,
narrower seam, `IssueTracker`, with GitHub as its implementation.

## The five non-negotiables

These travel with the module and are never optional. Each is stated as a hard rule in `SKILL.md`:

1. **Never let the app write a status.** GitHub's state is the only writer, through the webhook and the
   reconcile pass. Members have no UPDATE policy and no privilege, and nobody has a close button; the RLS
   checks in `references/data-model.md` show an update refused.
2. **Never show a tracker comment to a tenant unless it opts in.** Visible only with `/reply` on the first
   line from an owner, member or collaborator of the repository. `parseReplyCommand` and `planDelivery`
   carry the rule and their suites hold it.
3. **Never call the tracker inside the request that saves the report.** Save, enqueue, return; the outbox
   sends and de-duplicates by marker on every retry, so a report is never refused or doubled by GitHub's
   state.
4. **Never publish an attachment.** Private bucket, a 404 for everyone but an operator or the report's
   tenant, a 60-second signed URL, no SVG or HTML. The policies confine reservations to the tenant's folder.
5. **Never let the assistant send.** The draft tool reads nothing and writes nothing; the member's click on
   the card runs the same Server Action as the form.

Everything else is the host app's: its members, its operators, its database client, its notifications, its
look and its language.

## Requirements

- **Next.js App Router** with Server Actions and `after()`, on a Node runtime.
- **Postgres with Supabase** for the reference store: RLS, Storage and the two clients. Another stack ports
  the store on the rules in `references/adaptation.md`.
- A **GitHub App** you control, installed on one private repository, and a host the proxy serves without
  resolving a tenant for the operators and the webhook.
- A scheduler that calls a route every five minutes with a bearer: Vercel Cron, or any other.
- `zod`, `@supabase/supabase-js`, `@supabase/ssr`, `server-only`, `vitest` for the suites, and `ai` 7 for
  the assistant tool, installed with the app's package manager.

## Security

The webhook verifies `X-Hub-Signature-256` over the raw body with a timing-safe comparison and fails closed
without a secret. The installation token is requested narrowed to one repository and to issues. Member text
reaches GitHub with HTML comments removed and mentions neutralised; nothing a member types can forge a
marker or ping a person. Attachments are never public, and a probe for another tenant's file is a 404. The
worker fails closed without `CRON_SECRET`, and the proxy bypass admits exactly the paths in `vercel.json`.

## Verification

The pure logic and the GitHub client carry 49 tests in nine vitest suites. Every TypeScript block,
including the routes, actions, pages and components, type-checks under `strict` and
`noUncheckedIndexedAccess` against `next` 16, `react` 19, `ai` 7, `zod` 4, `@supabase/supabase-js` 2 and
`@supabase/ssr`. The migration was applied to an empty Postgres and its policies exercised as the
`authenticated` role; `references/data-model.md` lists the checks. What is not covered is stated in
`references/testing.md`: the two host fragments in `references/assistant-tool.md` are not compiled, the
server modules are not exercised against a database by the suites, and nothing here talks to GitHub. The
go-live list in `references/operations.md` is that pass.

## Not this

| Not this | Use instead |
|---|---|
| Capturing crashes and exceptions automatically | An error monitoring service. This module files what a person writes |
| A help center with articles and search | The `help-center-markdown` skill; link its pages to the report form |
| Customer support conversations and SLAs | A support inbox. Reports here go to engineers, not to agents |
| An assistant in Slack with approvals | The `slack-ai-bot` skill |
| Mirroring every issue of a repository | A GitHub sync tool. This module bridges the issues it created, by label and marker |

## Contributing

Issues and pull requests are welcome here. Pure markdown, with no build step, but the code blocks are checked:
every TypeScript block names its destination on the first line, and the blocks are written to compile as one
project under `strict` and `noUncheckedIndexedAccess`, with the suites in `assets/tests/` passing under
vitest, 49 tests. Claims in this skill are meant to be verifiable: if you change a factual claim, say how you
verified it, whether against GitHub's REST and webhook documentation, the Supabase client, the AI SDK, or a
reproduction.

Adding, removing or renaming a file in `references/` means updating the quick start and the reference
directory table in `SKILL.md`, the file table above, and any relative cross-links. Every odd-looking part of
the templates is there for a reason, and `references/provenance.md` is the ledger that must stay truthful:
read it before simplifying anything, and add an entry for anything you change. Commits follow Conventional
Commits and releases follow [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) in the
index; `CLAUDE.md` carries the full editing conventions.

## Part of the Timerise Skills

This is one of the [Timerise Skills](https://github.com/timerise-ai/skills): modules for **Next.js App
Router** apps written by our own senior engineers from the modules they have shipped, not synthetic, each
published as its own repository and indexed there. They share one layout, so an agent that has read one knows
how to read the next: a `SKILL.md` entry point, `references/` loaded on demand, and a seam contract carrying
the module's non-negotiables.

## Author

Built and maintained by [Timerise](https://timerise.ai).

## License

MIT. See [LICENSE](LICENSE).
