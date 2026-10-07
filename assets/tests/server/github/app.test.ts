// server/github/app.test.ts
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubBridgeEnv } from "@/lib/github/env";
import { commentMarker, reportMarker } from "@/lib/bug-reports/tracker-format";
import { githubTracker } from "@/server/bug-reports/tracker";
import { GithubError, createAppJwt, getInstallationToken, githubRequest, resetGithubTokenCache } from "./app";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const env: GithubBridgeEnv = {
  appId: "42",
  privateKey: pem,
  installationId: "7",
  owner: "acme",
  repo: "app",
  webhookSecret: "x",
  label: "tenant-report",
  operatorOrigin: "https://ops.example.com",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const token = (value: string, ttlMs = 3600_000) => json(201, { token: value, expires_at: new Date(Date.now() + ttlMs).toISOString() });
const queue = (...responses: Response[]) => vi.fn(async () => responses.shift() ?? json(500, {}));

beforeEach(() => resetGithubTokenCache());

describe("createAppJwt", () => {
  it("is an RS256 JWT from the App, backdated for skew and under ten minutes", () => {
    const now = Date.UTC(2026, 9, 6, 10, 0, 0);
    const [h = "", p = "", s = ""] = createAppJwt("42", pem, now).split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe("42");
    expect(claims.iat).toBe(now / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("takes a PKCS#8 key too", () => {
    expect(createAppJwt("42", privateKey.export({ type: "pkcs8", format: "pem" }).toString()).split(".")).toHaveLength(3);
  });
});

describe("getInstallationToken", () => {
  it("asks for one repository and issues only, and caches the token", async () => {
    const fetchImpl = queue(token("t1"));
    expect(await getInstallationToken(env, { fetchImpl })).toBe("t1");
    expect(await getInstallationToken(env, { fetchImpl })).toBe("t1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/7/access_tokens");
    expect(JSON.parse(init.body as string)).toEqual({ repositories: ["app"], permissions: { issues: "write", metadata: "read" } });
  });

  it("refreshes a token within five minutes of expiry", async () => {
    const fetchImpl = queue(token("short", 60_000), token("fresh"));
    await getInstallationToken(env, { fetchImpl });
    expect(await getInstallationToken(env, { fetchImpl })).toBe("fresh");
  });
});

describe("githubRequest", () => {
  it("retries once with a fresh token after a 401", async () => {
    const fetchImpl = queue(token("old"), json(401, {}), token("new"), json(201, { id: 5 }));
    expect(await githubRequest<{ id: number }>(env, "POST", "/x", { body: "hi" }, { fetchImpl })).toEqual({ id: 5 });
    const headers = (fetchImpl.mock.calls[3] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer new");
  });

  it("calls the tracker's outage retryable and our bad payload not", async () => {
    const run = async (res: Response) => {
      resetGithubTokenCache();
      return githubRequest(env, "POST", "/x", {}, { fetchImpl: queue(token("t"), res) }).catch((e: unknown) => e as GithubError);
    };
    expect(((await run(json(502, {}))) as GithubError).retryable).toBe(true);
    expect(((await run(json(429, {}, { "retry-after": "30" }))) as GithubError).retryAfterSeconds).toBe(30);
    expect(((await run(json(403, { message: "API rate limit exceeded" }))) as GithubError).retryable).toBe(true);
    expect(((await run(json(422, { message: "Validation Failed" }))) as GithubError).retryable).toBe(false);
    expect(((await run(json(404, {}))) as GithubError).retryable).toBe(false);
  });

  it("calls a network failure retryable", async () => {
    const err = await githubRequest(env, "GET", "/x", undefined, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).retryable).toBe(true);
  });
});

describe("githubTracker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds a marker past the first hundred issues and comments, so a retry opens no duplicate", async () => {
    const [r1, r2, c1] = ["5f0c4e2a-0000-4000-8000-000000000001", "5f0c4e2a-0000-4000-8000-000000000002", "5f0c4e2a-0000-4000-8000-000000000003"];
    const full = (body: string) => Array.from({ length: 100 }, (_, i) => ({ id: i, number: 1000 - i, body }));
    const issue = { number: 5, node_id: "I5", html_url: "https://github.com/acme/app/issues/5", body: `x\n\n${reportMarker(r1)}` };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) return token("t");
      const second = new URL(url).searchParams.get("page") === "2";
      if (url.includes("/comments")) return json(200, second ? [{ id: 77, body: `hi\n\n${commentMarker(c1)}` }] : full("other"));
      return json(200, second ? [issue] : full("other"));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const tracker = githubTracker(env);
    expect(await tracker.findIssueByMarker(r1, new Date(0))).toEqual({ number: 5, nodeId: "I5", url: issue.html_url });
    expect(await tracker.findCommentByMarker(5, c1, new Date(0))).toEqual({ id: 77 });
    expect(await tracker.findIssueByMarker(r2, new Date(0))).toBeNull();
  });
});
