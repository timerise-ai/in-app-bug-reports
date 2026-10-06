// lib/cron-paths.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CRON_PATHS, isCronPath } from "./cron-paths";

const vercel = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons?: { path: string }[] };

describe("CRON_PATHS", () => {
  it("is exactly the cron list in vercel.json: a cron missing from it answers 404 in production", () => {
    expect([...CRON_PATHS].sort()).toEqual((vercel.crons ?? []).map((c) => c.path).sort());
  });

  it("matches the route itself and nothing next to it", () => {
    expect(isCronPath("/api/bug-reports/worker")).toBe(true);
    expect(isCronPath("/api/bug-reports/worker/")).toBe(true);
    expect(isCronPath("/api/bug-reports/worker-x")).toBe(false);
    expect(isCronPath("/api/bug-reports/attachments/x")).toBe(false);
  });
});
