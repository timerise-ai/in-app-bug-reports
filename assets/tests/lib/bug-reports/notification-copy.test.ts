// lib/bug-reports/notification-copy.test.ts
import { describe, expect, it } from "vitest";
import { excerpt, noticeRecipients, reportNotice } from "./notification-copy";

const report = { number: 12, title: "Saving the time does nothing" };

describe("reportNotice", () => {
  it("names the report and its new status, with the title as the body", () => {
    expect(reportNotice(report, { kind: "status", status: "resolved" })).toEqual({ title: "Report #12 resolved", body: report.title });
    expect(reportNotice(report, { kind: "status", status: "open" }).title).toBe("Report #12 reopened");
    expect(reportNotice(report, { kind: "status", status: "odd" }).title).toBe("Report #12 changed status");
  });

  it("quotes a reply or a comment, falling back to the title", () => {
    expect(reportNotice(report, { kind: "reply", body: "**Fixed** in [1.2](https://x)" }).body).toBe("Fixed in 1.2");
    expect(reportNotice(report, { kind: "reply" }).body).toBe(report.title);
    expect(reportNotice(report, { kind: "comment", authorName: "Ann", body: "Me too" })).toEqual({ title: "Ann commented on report #12", body: "Me too" });
  });
});

describe("noticeRecipients", () => {
  it("is the reporter and the commenters, once each, without the actor", () => {
    expect(noticeRecipients("r", ["c1", "r", null, "c1"], null)).toEqual(["r", "c1"]);
    expect(noticeRecipients("r", ["c1"], "c1")).toEqual(["r"]);
    expect(noticeRecipients(null, [], null)).toEqual([]);
  });
});

describe("excerpt", () => {
  it("flattens to one line and cuts on a word", () => {
    expect(excerpt("a\n\nb   c")).toBe("a b c");
    const long = excerpt(`${"word ".repeat(40)}end`, 50);
    expect(long.endsWith("...")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(53);
    expect(long).not.toMatch(/\s\.\.\.$/);
  });
});
