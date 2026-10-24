// Prompt convention (user, 2026-10-24): no prompt carries an example. Where an example would go, the prompt states the
// general principle the example was meant to show. Examples steer the model toward one domain and mean nothing on the
// descriptions it has not seen.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as prompts from "../web/core/prompts.js";

const EXAMPLE_MARKERS = /\bfor example\b|\bfor instance\b|\be\.g\.|\bsuch as\b/i;

test("regression: no model-facing prompt carries an example", () => {
  for (const [name, value] of Object.entries(prompts)) {
    const text = typeof value === "function" ? value(["problem"]) : String(value);
    assert.doesNotMatch(text, EXAMPLE_MARKERS, `${name} contains an example marker`);
  }
});
