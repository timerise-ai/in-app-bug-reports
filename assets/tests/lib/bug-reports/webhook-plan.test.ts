// lib/bug-reports/webhook-plan.test.ts
import { describe, expect, it } from "vitest";
import { commentMarker } from "./tracker-format";
import { planDelivery, type GithubPayload } from "./webhook-plan";

const bridge = { appId: "4242", installationId: "77", repo: "acme/app" };
const COMMENT_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const issue = { number: 5, state: "open", body: "" };
const ours = (p: Partial<GithubPayload>): GithubPayload => ({ installation: { id: 77 }, repository: { full_name: "acme/app" }, issue, ...p });

describe("planDelivery", () => {
  it("ignores other events, and flags a foreign installation or repository as misconfiguration", () => {
    expect(planDelivery("push", ours({}), bridge)).toEqual({ kind: "ignore", reason: "event:push", misconfigured: false });
    expect(planDelivery("issues", ours({ installation: { id: 1 } }), bridge)).toMatchObject({ kind: "ignore", misconfigured: true });
    expect(planDelivery("issues", ours({ repository: { full_name: "evil/repo" } }), bridge)).toMatchObject({ kind: "ignore", misconfigured: true });
  });

  it("matches the repository case-insensitively and ignores pull requests", () => {
    expect(planDelivery("issues", ours({ action: "closed", repository: { full_name: "ACME/App" }, issue: { ...issue, state: "closed" } }), bridge).kind).toBe("status");
    expect(planDelivery("issues", ours({ action: "closed", issue: { ...issue, pull_request: {} } }), bridge)).toMatchObject({ reason: "not_an_issue" });
  });

  it("turns closed and reopened into a status, with the close time", () => {
    const closed = planDelivery("issues", ours({ action: "closed", issue: { ...issue, state: "closed", state_reason: "not_planned", closed_at: "2026-10-06T12:00:00Z" } }), bridge);
    expect(closed).toMatchObject({ kind: "status", status: "not_planned", closedAt: "2026-10-06T12:00:00Z" });
    expect(planDelivery("issues", ours({ action: "reopened" }), bridge)).toMatchObject({ kind: "status", status: "open", closedAt: null });
  });

  it("detaches on delete and transfer, and ignores an edit", () => {
    expect(planDelivery("issues", ours({ action: "transferred" }), bridge)).toMatchObject({ kind: "detach", action: "transferred" });
    expect(planDelivery("issues", ours({ action: "edited" }), bridge)).toMatchObject({ kind: "ignore", reason: "issues.edited" });
  });

  it("recognises the App's own comment by marker or by the App id, and keeps its local id", () => {
    const marked = planDelivery("issue_comment", ours({ action: "created", comment: { id: 9, body: `x ${commentMarker(COMMENT_ID)}` } }), bridge);
    expect(marked).toEqual({ kind: "echo", issue: { number: 5, body: "" }, trackerCommentId: 9, localCommentId: COMMENT_ID });
    const viaApp = planDelivery("issue_comment", ours({ action: "edited", comment: { id: 9, body: "x", performed_via_github_app: { id: 4242 } } }), bridge);
    expect(viaApp).toMatchObject({ kind: "echo", localCommentId: null });
  });

  it("marks a team /reply visible and anything else internal", () => {
    const reply = planDelivery("issue_comment", ours({ action: "created", comment: { id: 3, body: "/reply Fixed.", author_association: "MEMBER", user: { login: "dev" } } }), bridge);
    expect(reply).toMatchObject({ kind: "comment", visible: true, body: "Fixed.", login: "dev", trackerCommentId: 3 });
    const internal = planDelivery("issue_comment", ours({ action: "created", comment: { id: 4, body: "race in store", author_association: "MEMBER" } }), bridge);
    expect(internal).toMatchObject({ kind: "comment", visible: false });
  });

  it("passes a deleted comment through, and ignores other comment actions", () => {
    expect(planDelivery("issue_comment", ours({ action: "deleted", comment: { id: 3 } }), bridge)).toMatchObject({ kind: "comment_deleted", trackerCommentId: 3 });
    expect(planDelivery("issue_comment", ours({ action: "pinned", comment: { id: 3 } }), bridge)).toMatchObject({ kind: "ignore" });
    expect(planDelivery("issue_comment", ours({ action: "created" }), bridge)).toMatchObject({ reason: "no_comment" });
  });
});
