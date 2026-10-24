// Search/replace edits to a previous stage program (loop-2 candidate r4: retries cost a few lines, not a rewrite).
import test from "node:test";
import assert from "node:assert/strict";
import { applyAnswer } from "../web/core/edits.js";

const PREV = "def generate(db, rng):\n    r = rng('a')\n    for i in range(10):\n        db.execute('INSERT INTO t VALUES (?)', (i,))\n";
const block = (s, r) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

test("edits apply in order to the previous program", () => {
  const a = applyAnswer(PREV, `Fixing the count.\n${block("    for i in range(10):", "    for i in range(r.randint(30, 60)):")}\n` +
    block("(i,))", "(i + 1,))"));
  assert.equal(a.edits, 2);
  assert.equal(a.code, PREV.replace("range(10)", "range(r.randint(30, 60))").replace("(i,))", "(i + 1,))"));
});

test("a complete program in a python block still replaces the previous one", () => {
  const a = applyAnswer(PREV, "```python\ndef generate(db, rng):\n    pass\n```");
  assert.equal(a.edits, 0);
  assert.equal(a.code.trim(), "def generate(db, rng):\n    pass");
});

test("an edit whose search text is missing, ambiguous or empty is an error, not a silent no-op", () => {
  assert.match(applyAnswer(PREV, block("range(99)", "x")).error, /not in the previous program/);
  assert.match(applyAnswer(PREV + PREV, block("    r = rng('a')", "x")).error, /more than once/);
  assert.match(applyAnswer(PREV, "<<<<<<< SEARCH\n\n=======\nx\n>>>>>>> REPLACE").error, /empty/);
  assert.match(applyAnswer(PREV, "no code here").error, /no Python code block/);
});

test("a later edit sees the result of an earlier one", () => {
  const a = applyAnswer(PREV, block("range(10)", "range(N)") + "\n" + block("range(N)", "range(20)"));
  assert.equal(a.code, PREV.replace("range(10)", "range(20)"));
});
