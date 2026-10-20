// The whole pipeline offline: a scripted model drives every path (a spec, a plan, a stage that first fails a rule,
// a stage that first ignores its seed, an audit with a tool call and an accepted rule, a regeneration, a clean second
// audit), on the real runtime. Then the package's standalone generate.py/verify.py run under the system Python.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { nodeRuntime } from "../node/runtime-node.mjs";
import { Pipeline, validatePlan, defaultPlan, hiddenSeeds } from "../web/core/pipeline.js";
import { packageFiles } from "../web/core/package.js";
import { scriptedModel } from "./scripted.mjs";

const rt = nodeRuntime();
test.after(() => rt.close());

test("plan validation and the deterministic plan", () => {
  const tables = [{ name: "a", references: [] }, { name: "b", references: ["a"] }, { name: "c", references: ["b"] }];
  assert.deepEqual(validatePlan([{ tables: ["a", "b"] }, { tables: ["c"] }], tables), []);
  assert.match(validatePlan([{ tables: ["b"] }, { tables: ["a", "c"] }], tables).join(" "), /written later/);
  assert.match(validatePlan([{ tables: ["a"] }], tables).join(" "), /in no stage/);
  assert.deepEqual(defaultPlan(tables).map((s) => s.tables), [["a"], ["b"], ["c"]]);
  const [h1, h2] = hiddenSeeds("run-x");
  assert.ok(h1 >= 100000 && h2 === h1 + 1 && hiddenSeeds("run-x")[0] === h1);
});

test("the pipeline runs end to end and its package rebuilds and verifies outside the app", async () => {
  const llm = scriptedModel();
  const events = [];
  const p = new Pipeline({ llm, runtime: rt, emit: (e) => events.push(e), runId: "test-run", settings: { auditRounds: 3 } });
  const state = await p.run("A small venue with meeting rooms and bookings of groups that fit the rooms.");
  // the room stage was first a fixed table (seed-use gate), then passed
  assert.equal(llm.seen.code.room, 2);
  const roomStep = state.lineage.find((s) => s.title.startsWith("Stage 1"));
  assert.equal(roomStep.status, "done");
  // the audit rule was accepted and the booking stage regenerated to meet it
  assert.ok(state.rules.some((r) => r.id === "rarely_full" && /audit round 1/.test(r.origin)));
  assert.equal(state.rounds.length, 2);
  assert.deepEqual(state.rounds[0].accepted, ["full_rooms"]);
  assert.equal(state.rounds[1].flaws.length, 0);
  // every rule passes on both final databases
  for (const v of Object.values(state.verification)) for (const [id, r] of Object.entries(v)) assert.ok(r.passed, id);
  assert.ok(events.some((e) => e.type === "finished"));
  // the package, rebuilt and verified with the system Python
  const dir = mkdtempSync(join(tmpdir(), "sdb-"));
  for (const [name, content] of Object.entries(packageFiles(state))) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const seed = Number(Object.keys(state.databases)[0]);
  execFileSync("python", [join(dir, "generate.py"), "--seed", String(seed), "--out", join(dir, "rebuilt.sqlite")]);
  const ok = execFileSync("python", [join(dir, "verify.py"), join(dir, "rebuilt.sqlite")]).toString();
  assert.match(ok, /all checks pass/);
  const dump = (f) => execFileSync("python", ["-c",
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print([c.execute(f'SELECT * FROM {t} ORDER BY 1').fetchall() for t in ('room','booking')])", f]).toString();
  assert.equal(dump(join(dir, "rebuilt.sqlite")), dump(join(dir, "database.sqlite")));
});
