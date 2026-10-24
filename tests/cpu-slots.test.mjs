// The machine-wide cap on runtime calls (node/runtime-node.mjs slots): a call waits for a slot before its time limit
// starts, a dead owner's slot is reclaimed, and a slot is freed when its call fails.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeRuntime, acquireSlot } from "../node/runtime-node.mjs";
import { TimeoutError } from "../web/core/runtime.js";

const SCHEMA = "CREATE TABLE t (id INTEGER PRIMARY KEY);";
const SLEEPY = "import time\n\ndef generate(db, rng):\n    time.sleep(1.5)\n    db.execute('INSERT INTO t VALUES (1)')\n";
const build = (rt, timeoutMs) => rt.call("build", { schema: SCHEMA, triggers: "", stages: [{ index: 0, tables: ["t"], code: SLEEPY }], seed: 1 },
  { code: SLEEPY, timeoutMs });
const warm = (rt) => rt.call("check_spec", { schema: SCHEMA, triggers: "", verifiers: "" }, { timeoutMs: 120000 });

test("with one slot two calls run one after the other, and the wait does not count toward the time limit", async () => {
  const slotDir = mkdtempSync(join(tmpdir(), "sdb-slots-"));
  const a = nodeRuntime({ slots: 1, slotDir });
  const b = nodeRuntime({ slots: 1, slotDir });
  try {
    await warm(a);
    await warm(b);
    const t0 = Date.now();
    // each build sleeps 1.5 s under a 2.5 s limit: together they take 3+ s, so the second only passes if its limit
    // started after the first released the slot
    const [ra, rb] = await Promise.all([build(a, 2500), build(b, 2500)]);
    assert.ok(ra.result.ok && rb.result.ok);
    assert.ok(Date.now() - t0 >= 3000, "the calls overlapped");
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    a.close();
    b.close();
  }
});

test("a slot held by a process that is gone is reclaimed", async () => {
  const slotDir = mkdtempSync(join(tmpdir(), "sdb-slots-"));
  mkdirSync(join(slotDir, "slot-0"));
  writeFileSync(join(slotDir, "slot-0", "pid"), "2147483000");
  const rt = nodeRuntime({ slots: 1, slotDir });
  try {
    assert.ok(Array.isArray((await warm(rt)).result.problems));
  } finally {
    rt.close();
  }
});

test("a call that runs over its limit frees its slot", async () => {
  const slotDir = mkdtempSync(join(tmpdir(), "sdb-slots-"));
  const rt = nodeRuntime({ slots: 1, slotDir });
  try {
    await warm(rt);
    await assert.rejects(build(rt, 500), TimeoutError);
    assert.deepEqual(readdirSync(slotDir), []);
    assert.ok(Array.isArray((await warm(rt)).result.problems)); // the next call gets the slot (and a fresh worker)
  } finally {
    rt.close();
  }
});

test("regression: a slot directory Windows refuses for a moment (EPERM) is treated as busy, and a refused release does not throw", async () => {
  const slotDir = mkdtempSync(join(tmpdir(), "sdb-slots-"));
  let refusals = 1;
  const fsx = {
    mkdirSync: (p) => { if (refusals-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, mkdir"), { code: "EPERM" }); mkdirSync(p); },
    writeFileSync,
    rmSync: () => { throw Object.assign(new Error("EPERM: operation not permitted, rmdir"), { code: "EPERM" }); },
  };
  const release = await acquireSlot(slotDir, 2, fsx);
  assert.deepEqual(readdirSync(slotDir), ["slot-1"]); // slot-0 was refused, slot-1 taken
  assert.doesNotThrow(release);
});
