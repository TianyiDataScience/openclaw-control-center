import assert from "node:assert/strict";
import test from "node:test";
import { formatDateForTimeZone, formatTimestampForUi, normalizeUiTimeZone } from "../src/runtime/ui-timezone";

test("normalizeUiTimeZone falls back to UTC for invalid values", () => {
  assert.equal(normalizeUiTimeZone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(normalizeUiTimeZone("Mars/Base"), "UTC");
});

test("formatTimestampForUi renders ISO timestamps in the configured timezone", () => {
  assert.equal(
    formatTimestampForUi("2026-04-03T08:23:36.123Z", "Asia/Shanghai"),
    "2026-04-03 16:23",
  );
  assert.equal(
    formatTimestampForUi("2026-04-03T08:23:36.123Z", "Asia/Shanghai", { includeSeconds: true }),
    "2026-04-03 16:23:36",
  );
});

test("formatTimestampForUi preserves date-only values and raw invalid strings", () => {
  assert.equal(formatTimestampForUi("2026-04-03", "Asia/Shanghai"), "2026-04-03");
  assert.equal(formatTimestampForUi("not-a-date", "Asia/Shanghai"), "not-a-date");
  assert.equal(formatTimestampForUi(undefined, "Asia/Shanghai"), "-");
});

test("formatDateForTimeZone returns the calendar day in the configured timezone", () => {
  assert.equal(formatDateForTimeZone("2026-04-03T01:30:00.000Z", "America/New_York"), "2026-04-02");
  assert.equal(formatDateForTimeZone("2026-04-03T08:23:36.123Z", "Asia/Shanghai"), "2026-04-03");
});
