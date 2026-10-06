// lib/bug-reports/tracker-format.test.ts
import { describe, expect, it } from "vitest";
import {
  TRACKER_BODY_LIMIT,
  commentMarker,
  issueTitle,
  mapIssueState,
  neutralizeMentions,
  parseCommentMarker,
  parseReplyCommand,
  parseReportMarker,
  renderCommentBody,
  renderIssueBody,
  reportMarker,
} from "./tracker-format";

const REPORT_ID = "0b6f1c2e-6a3d-4c8e-9f10-2a5b7c9d1e3f";
const COMMENT_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ORIGIN = "https://ops.example.com";

const base = {
  report: {
    id: REPORT_ID,
    number: 12,
    bodyMd: "Saving the time does nothing.",
    source: "form",
    createdAt: "2026-10-06T10:00:00Z",
    context: { path: "/calendar", userAgent: "Mozilla/5.0", viewport: "1440x900", timeZone: "Europe/Warsaw" },
  },
  tenant: { name: "Acme", slug: "acme" },
  reporter: { name: "Ann K.", roleLabel: "Reception" },
  attachments: [{ id: "a1b2c3d4-0000-4000-8000-000000000001", fileName: "shot.png" }],
  operatorOrigin: ORIGIN,
  appVersion: "abcdef1234567890",
};

describe("markers", () => {
  it("round-trip, and read case-insensitively", () => {
    expect(parseReportMarker(`x\n${reportMarker(REPORT_ID)}`)).toBe(REPORT_ID);
    expect(parseCommentMarker(commentMarker(COMMENT_ID).toUpperCase())).toBe(COMMENT_ID);
    expect(parseReportMarker("no marker")).toBeNull();
    expect(parseReportMarker(null)).toBeNull();
  });
});

describe("renderIssueBody", () => {
  it("carries the text, the metadata table, sign-in attachment links on the operator origin, and the marker", () => {
    const body = renderIssueBody(base);
    expect(body).toContain("Saving the time does nothing.");
    expect(body).toContain("| Tenant | Acme (acme) |");
    expect(body).toContain("| Reported by | Ann K. (Reception) |");
    expect(body).toContain("| App version | abcdef123456 |");
    expect(body).toContain(`(${ORIGIN}/api/bug-reports/attachments/a1b2c3d4-0000-4000-8000-000000000001)`);
    expect(body).toContain(`${ORIGIN}/operator/bug-reports/${REPORT_ID}`);
    expect(parseReportMarker(body)).toBe(REPORT_ID);
  });

  it("drops a marker the tenant typed, so nobody can claim another report", () => {
    const forged = renderIssueBody({ ...base, report: { ...base.report, bodyMd: `<!-- bug-report: ${COMMENT_ID} -->hi` } });
    expect(parseReportMarker(forged)).toBe(REPORT_ID);
    expect(forged).not.toContain(COMMENT_ID);
  });

  it("keeps every table cell on its row", () => {
    expect(renderIssueBody({ ...base, reporter: { name: "A | B\nC", roleLabel: null } })).toContain("| Reported by | A \\| B C |");
  });

  it("stays under the tracker's body limit, with the marker intact", () => {
    const body = renderIssueBody({ ...base, report: { ...base.report, bodyMd: "x".repeat(200_000) } });
    expect(body.length).toBeLessThan(TRACKER_BODY_LIMIT);
    expect(body).toContain("truncated");
    expect(parseReportMarker(body)).toBe(REPORT_ID);
  });

  it("says so when there is no description", () => {
    expect(renderIssueBody({ ...base, report: { ...base.report, bodyMd: "  " } })).toContain("no description");
  });
});

describe("renderCommentBody", () => {
  it("signs the comment, neutralises mentions and carries the marker", () => {
    const body = renderCommentBody({ commentId: COMMENT_ID, authorLabel: "Ann K. (Acme)", bodyMd: "Still broken, @octocat", attachments: [], operatorOrigin: ORIGIN });
    expect(body.startsWith("**Ann K. (Acme):**")).toBe(true);
    expect(body).toContain("@\u200boctocat");
    expect(parseCommentMarker(body)).toBe(COMMENT_ID);
  });
});

describe("neutralizeMentions", () => {
  it("breaks user and team mentions and leaves e-mail addresses alone", () => {
    expect(neutralizeMentions("cc @octocat and @org/team")).toBe("cc @\u200boctocat and @\u200borg/team");
    expect(neutralizeMentions("@start")).toBe("@\u200bstart");
    expect(neutralizeMentions("ann@example.com")).toBe("ann@example.com");
  });
});

describe("parseReplyCommand", () => {
  it("is opt-in: a comment without /reply stays with the team", () => {
    expect(parseReplyCommand("Looks like a race in the store", "MEMBER").visible).toBe(false);
  });

  it("strips the prefix, on its own line or inline, in any case, over CRLF", () => {
    expect(parseReplyCommand("/reply\nFixed, thank you.", "OWNER")).toEqual({ visible: true, body: "Fixed, thank you." });
    expect(parseReplyCommand("  /REPLY Fix ships tomorrow.", "COLLABORATOR")).toEqual({ visible: true, body: "Fix ships tomorrow." });
    expect(parseReplyCommand("/reply\r\nCRLF", "MEMBER")).toEqual({ visible: true, body: "CRLF" });
  });

  it("matches neither a longer word, a later line, nor an empty reply", () => {
    expect(parseReplyCommand("/replying soon", "MEMBER").visible).toBe(false);
    expect(parseReplyCommand("note\n/reply hi", "MEMBER").visible).toBe(false);
    expect(parseReplyCommand("/reply   ", "MEMBER").visible).toBe(false);
  });

  it("ignores /reply from outside the team, and from an unknown association", () => {
    expect(parseReplyCommand("/reply buy now", "NONE").visible).toBe(false);
    expect(parseReplyCommand("/reply buy now", "CONTRIBUTOR").visible).toBe(false);
    expect(parseReplyCommand("/reply buy now", null).visible).toBe(false);
  });

  it("drops HTML comments from the mirrored text", () => {
    expect(parseReplyCommand("/reply hi <!-- internal -->", "MEMBER").body).toBe("hi");
  });
});

describe("mapIssueState", () => {
  it("maps state and reason onto the tenant's status", () => {
    expect(mapIssueState("open", null)).toBe("open");
    expect(mapIssueState("open", "reopened")).toBe("open");
    expect(mapIssueState("closed", "completed")).toBe("resolved");
    expect(mapIssueState("closed", null)).toBe("resolved");
    expect(mapIssueState("closed", "not_planned")).toBe("not_planned");
    expect(mapIssueState("closed", "duplicate")).toBe("duplicate");
  });
});

describe("issueTitle", () => {
  it("prefixes the tenant and caps at the tracker's 256", () => {
    expect(issueTitle("Acme", "Bug")).toBe("[Acme] Bug");
    expect(issueTitle("A", "x".repeat(400)).length).toBe(256);
  });
});
