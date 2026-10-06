// lib/github/env.test.ts
import { describe, expect, it } from "vitest";
import { githubBridgeEnv, githubWebhookSecret, parseRepo } from "./env";

const FULL = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_INSTALLATION_ID: "456",
  GITHUB_REPORTS_REPO: "acme/app",
  GITHUB_WEBHOOK_SECRET: "s3cret",
  OPERATOR_ORIGIN: "https://ops.example.com/",
};

describe("githubBridgeEnv", () => {
  it("is null unless every value is present: one answer for a half-configured deployment", () => {
    expect(githubBridgeEnv({})).toBeNull();
    for (const key of Object.keys(FULL)) expect(githubBridgeEnv({ ...FULL, [key]: "" }), key).toBeNull();
  });

  it("restores escaped newlines, trims the origin and defaults the label", () => {
    const env = githubBridgeEnv(FULL);
    expect(env?.privateKey).toContain("\nabc\n");
    expect(env).toMatchObject({ owner: "acme", repo: "app", label: "tenant-report", operatorOrigin: "https://ops.example.com" });
    expect(githubBridgeEnv({ ...FULL, GITHUB_REPORTS_LABEL: "tenant-report-preview" })?.label).toBe("tenant-report-preview");
  });

  it("accepts owner/name only", () => {
    expect(githubBridgeEnv({ ...FULL, GITHUB_REPORTS_REPO: "app" })).toBeNull();
    expect(parseRepo("a/b/c")).toBeNull();
    expect(parseRepo(" a/b ")).toEqual({ owner: "a", repo: "b" });
  });

  it("reads the webhook secret on its own", () => {
    expect(githubWebhookSecret({ GITHUB_WEBHOOK_SECRET: " x " })).toBe("x");
    expect(githubWebhookSecret({})).toBeNull();
  });
});
