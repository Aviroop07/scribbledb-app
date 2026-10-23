// The planner's and coder's stance on realism (user decision 2026-10-23, option b): within the rules, rows are drawn
// from solved process parameters, never allocated as exact quotas. Exact-count allocation was the largest realism flaw
// family in autotune loop 2 (3.1 per finished run); this pins the stance so a prompt edit cannot silently bring it back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_SYSTEM, PLAN_SYSTEM } from "../web/core/prompts.js";

test("regression: the coder is not told to compute counts exactly", () => {
  assert.doesNotMatch(CODE_SYSTEM, /compute them exactly/i);
  assert.doesNotMatch(PLAN_SYSTEM, /decide counts and shares first/i);
});

test("regression: planner and coder draw from solved process parameters and never allocate quotas", () => {
  for (const p of [CODE_SYSTEM, PLAN_SYSTEM]) assert.match(p, /parameters of\s+plausible random processes/);
  assert.match(CODE_SYSTEM, /Never hand out exact quotas/);
  assert.match(CODE_SYSTEM, /on EVERY seed/); // rule satisfaction stays mandatory
});
