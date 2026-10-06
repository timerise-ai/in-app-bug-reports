// lib/bug-reports/retry.test.ts
import { describe, expect, it } from "vitest";
import { LEASE_SECONDS, MAX_ATTEMPTS, WAIT_FOR_ISSUE_SECONDS, decideRetry } from "./retry";

describe("decideRetry", () => {
  it("retries the tracker's outage until the budget is spent, then parks", () => {
    expect(decideRetry(1, { message: "502", retryable: true })).toEqual({ action: "retry", attempts: 1, delaySeconds: LEASE_SECONDS, error: "502" });
    expect(decideRetry(MAX_ATTEMPTS, { message: "502", retryable: true })).toEqual({ action: "park", error: "502" });
  });

  it("parks our own mistake at once", () => {
    expect(decideRetry(1, { message: "422", retryable: false })).toMatchObject({ action: "park" });
  });

  it("honours a longer Retry-After, never a shorter one", () => {
    expect(decideRetry(1, { message: "429", retryable: true, retryAfterSeconds: 900 })).toMatchObject({ delaySeconds: 900 });
    expect(decideRetry(1, { message: "429", retryable: true, retryAfterSeconds: 5 })).toMatchObject({ delaySeconds: LEASE_SECONDS });
  });

  it("gives the attempt back to a comment waiting for its issue, however often it waits", () => {
    expect(decideRetry(MAX_ATTEMPTS, { message: "pending", retryable: true, waitingForIssue: true })).toEqual({
      action: "retry",
      attempts: MAX_ATTEMPTS - 1,
      delaySeconds: WAIT_FOR_ISSUE_SECONDS,
      error: "pending",
    });
    expect(decideRetry(0, { message: "pending", retryable: true, waitingForIssue: true })).toMatchObject({ attempts: 0 });
  });

  it("caps the stored error", () => {
    const d = decideRetry(1, { message: "x".repeat(2000), retryable: true });
    expect(d.error.length).toBe(500);
  });
});
