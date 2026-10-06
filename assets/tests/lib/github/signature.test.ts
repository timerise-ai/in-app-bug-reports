// lib/github/signature.test.ts
import { describe, expect, it } from "vitest";
import { signGithubPayload, verifyGithubSignature } from "./signature";

describe("verifyGithubSignature", () => {
  const body = '{"action":"closed","issue":{"number":1}}';
  const secret = "webhook-secret";

  it("accepts GitHub's signature of the raw body", () => {
    expect(verifyGithubSignature(body, signGithubPayload(body, secret), secret)).toBe(true);
  });

  it("refuses another body, another secret, a missing header and a missing secret", () => {
    const sig = signGithubPayload(body, secret);
    expect(verifyGithubSignature(`${body} `, sig, secret)).toBe(false);
    expect(verifyGithubSignature(body, sig, "other")).toBe(false);
    expect(verifyGithubSignature(body, null, secret)).toBe(false);
    expect(verifyGithubSignature(body, sig, null)).toBe(false);
  });

  it("returns false for a truncated or multi-byte header instead of throwing", () => {
    expect(verifyGithubSignature(body, "sha256=abc", secret)).toBe(false);
    expect(verifyGithubSignature(body, "sha1=abc", secret)).toBe(false);
    const sig = signGithubPayload(body, secret);
    expect(verifyGithubSignature(body, `${sig.slice(0, -2)}\u00e9`, secret)).toBe(false);
  });
});
