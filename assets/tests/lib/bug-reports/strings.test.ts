// lib/bug-reports/strings.test.ts
import { describe, expect, it } from "vitest";
import type { ActionErrorCode } from "./action-result";
import { NOTICE_STRINGS, consoleKeys } from "./strings";
import { REPORT_STATUSES } from "./types";

const ERROR_CODES: ActionErrorCode[] = ["invalid", "not_found", "rate_limited", "type", "size", "empty", "failed"];

describe("strings", () => {
  it("has console copy and a notice phrase for every status", () => {
    for (const s of REPORT_STATUSES) {
      expect(consoleKeys[`status.${s}`], s).toBeTruthy();
      expect(NOTICE_STRINGS.status[s], s).toBeTruthy();
    }
  });

  it("has console copy for every action error code", () => {
    for (const code of ERROR_CODES) expect(consoleKeys[`error.${code}`], code).toBeTruthy();
  });
});
