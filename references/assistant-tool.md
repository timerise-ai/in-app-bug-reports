# The assistant's draft tool

An in-app assistant is good at turning "it doesn't save the time" into a report with steps and an expected
result. It must not be able to send one. The tool drafts; a person reads the whole text and presses Send.

The pattern, which any tool that leads to a change should follow:

| Property | How this tool holds it |
|---|---|
| It reads nothing | No database client, no session, no `sources`: its output is its input, trimmed |
| It changes nothing | `execute` returns a value; there is no side effect to undo |
| The commit is the existing action | The card's Send runs `createReport`, as the member, under the same policies as the form |
| A person sees the whole text first | The card renders the title and the full markdown before the button |

A prompt injection hidden in data the assistant read can shape the draft. It still meets a person before it
meets the tracker, and the person sees exactly what will be sent.

## The tool

```typescript
// lib/bug-reports/draft.ts
import { REPORT_LIMITS } from "./types";

/** The assistant tool's name, as the chat UI sees it in a `tool-draft_bug_report` part. */
export const DRAFT_TOOL_NAME = "draft_bug_report";

export type DraftOutput = { draft: true; title: string; body: string };

/** Narrow a tool part's output back to a draft; anything else renders as nothing. */
export function parseDraftOutput(output: unknown): { title: string; body: string } | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.draft !== true || typeof o.title !== "string" || !o.title.trim()) return null;
  return {
    title: o.title.slice(0, REPORT_LIMITS.titleMax),
    body: typeof o.body === "string" ? o.body.slice(0, REPORT_LIMITS.bodyMax) : "",
  };
}
```

```typescript
// server/bug-reports/assistant-tool.ts
import { tool } from "ai";
import { z } from "zod";
import { DRAFT_TOOL_NAME, type DraftOutput } from "@/lib/bug-reports/draft";
import { REPORT_LIMITS } from "@/lib/bug-reports/types";

/**
 * `draft_bug_report`: the assistant's only tool that leads to a change, and it does not make it. It
 * reads nothing, writes nothing and returns what the model drafted. The chat UI renders that output as a
 * card showing the whole text; the report exists only after the member presses Send, which runs the
 * same Server Action as the form, as the member, under the same policies. A prompt injection that
 * shapes the draft still meets a person before it meets the tracker.
 */
export const draftBugReportInput = z.object({
  title: z.string().min(3).max(REPORT_LIMITS.titleMax).describe("A short, specific title"),
  body: z.string().max(8000).describe("Markdown: what happened, the steps, what was expected"),
});

export const draftBugReportTool = tool({
  description:
    "Prepare a DRAFT bug report or suggestion for the product team. It sends nothing: the user sees the " +
    "draft and presses Send. Use it when the user describes a defect in this app or asks to report one. " +
    "Keep the title short; write the body in markdown with the steps and the expected result. Never put " +
    "customer data (names, phone numbers, addresses) in it.",
  inputSchema: draftBugReportInput,
  execute: async ({ title, body }): Promise<DraftOutput> => ({ draft: true, title: title.trim(), body: body.trim() }),
});

/** One line for the system prompt, added only when the tool is in the toolset. */
export const DRAFT_TOOL_PROMPT_RULE =
  "You change nothing in the system, with one exception: when the user reports a defect or a suggestion " +
  `for the product team, prepare it with ${DRAFT_TOOL_NAME}. You never send it: the user sees the draft ` +
  "under your answer and presses Send or Edit in form. Ask for the steps first if the description is too " +
  "vague. Never put customer data in a draft.";
```

Register it with the host's other tools, only for members (every member may report, so no other check):

```typescript
// app/api/chat/route.ts (fragment: the host's chat route; only the two lines marked are this module's)
const tools = {
  ...hostTools,
  [DRAFT_TOOL_NAME]: draftBugReportTool, // this module
};
const system = [hostSystemPrompt, DRAFT_TOOL_PROMPT_RULE].join("\n"); // this module
```

That fragment is not compiled here: it depends on the host's route. The tool and the rule are.

If the host's prompt says the assistant changes nothing, keep that line and add the rule as its stated
exception; a prompt that says both "you change nothing" and "file reports" without saying how they fit
leaves the model to guess.

## The card

```tsx
// components/bug-reports/ReportDraftCard.tsx
"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { parseDraftOutput } from "@/lib/bug-reports/draft";
import { REPORT_DRAFT_STORAGE_KEY, type ReportDraft } from "@/lib/bug-reports/types";
import { createReport } from "@/app/bug-reports/actions";
import { collectReportContext } from "./context";
import { Markdown } from "./host-ui";
import { useReportStrings } from "./use-strings";

/**
 * The confirm card for a `tool-draft_bug_report` part whose state is `output-available`. The member sees
 * the whole draft; Send runs the same action as the form, Edit in form hands the draft over in
 * sessionStorage. Render it in place of the tool's chip in the chat's message parts.
 */
export function ReportDraftCard({
  output,
  onLeave,
}: {
  output: unknown;
  /** Closes the chat panel before navigating, when the chat is a panel. */
  onLeave?: () => void;
}) {
  const t = useReportStrings();
  const router = useRouter();
  const pathname = usePathname();
  const draft = parseDraftOutput(output);
  const [sent, setSent] = useState<{ id: string; number: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!draft) return null;
  const { title, body } = draft;

  function send() {
    start(async () => {
      const result = await createReport({ title, body, attachmentIds: [], source: "assistant", context: collectReportContext(pathname) });
      if (result.ok) setSent(result.value);
      else setError(t(`error.${result.error}`));
    });
  }

  function edit() {
    try {
      const handover: ReportDraft = { title, body, path: pathname };
      sessionStorage.setItem(REPORT_DRAFT_STORAGE_KEY, JSON.stringify(handover));
    } catch {
      // no sessionStorage: the form opens empty, and the text is still in the chat
    }
    onLeave?.();
    router.push("/bug-reports/new?from=assistant");
  }

  return (
    <div role="group" aria-label={t("draftHeading")}>
      <strong>{title}</strong>
      {body && <Markdown source={body} />}
      {sent ? (
        <p role="status">
          {t("draftSent", { number: sent.number })} <a href={`/bug-reports/${sent.id}`}>#{sent.number}</a>
        </p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          <button type="button" onClick={send} disabled={pending}>
            {t("draftSend")}
          </button>
          <button type="button" onClick={edit} disabled={pending}>
            {t("draftEdit")}
          </button>
        </>
      )}
    </div>
  );
}
```

Render it where the chat renders message parts, for the part whose type is `tool-draft_bug_report` and
whose `state` is `output-available`, in place of whatever chip the chat shows for a finished tool call:

```tsx
// components/chat/MessageParts.tsx (fragment: inside the host's map over message.parts)
if (part.type === `tool-${DRAFT_TOOL_NAME}` && part.state === "output-available") {
  return <ReportDraftCard key={i} output={part.output} onLeave={closePanel} />;
}
```

Also a fragment, for the same reason. Earlier states (`input-streaming`, `input-available`) render as
nothing or as the chat's usual "working" indicator: a half-written draft with a Send button under it is a
draft someone will send.

**Edit in form** writes the draft to sessionStorage and opens `/bug-reports/new?from=assistant`, where the
form reads it once and removes it. A URL cannot carry a long markdown body. That route is how a member adds
attachments to a drafted report: the assistant cannot.

## The link next to it

The assistant panel also carries a plain "Report a bug" link, with the current page as `path`, for a member
who would rather write it themselves. Put it next to the panel's disclosure or help link, where people look
for what the assistant cannot do.
