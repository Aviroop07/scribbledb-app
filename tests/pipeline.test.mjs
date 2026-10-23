// The whole pipeline offline: a scripted model drives every path (a spec, a plan, a stage that first fails a rule,
// a stage that first ignores its seed, an audit with a tool call and an accepted rule, a regeneration, a clean second
// audit), on the real runtime. Then the package's standalone generate.py/verify.py run under the system Python.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { nodeRuntime } from "../node/runtime-node.mjs";
import { Pipeline, validatePlan, defaultPlan, hiddenSeeds } from "../web/core/pipeline.js";
import { packageFiles } from "../web/core/package.js";
import { scriptedModel } from "./scripted.mjs";

const rt = nodeRuntime({ hashSeed: 0 });
const rt2 = nodeRuntime({ hashSeed: 1 });
test.after(() => { rt.close(); rt2.close(); });

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
  const p = new Pipeline({ llm, runtime: rt, checkRuntime: rt2, emit: (e) => events.push(e), runId: "test-run", settings: { auditRounds: 3 } });
  const state = await p.run("A small venue with meeting rooms and bookings of groups that fit the rooms.");
  // the first specification was malformed (a null rule, a rule without code): fixed on the second attempt
  assert.equal(llm.seen.spec, 2);
  // the room stage was first a fixed table (seed-use gate), then a set-order program (reproducibility check), then passed
  assert.equal(llm.seen.code.room, 3);
  const roomStep = state.lineage.find((s) => s.title.startsWith("Stage 1"));
  assert.equal(roomStep.status, "done");
  // the audit rule was accepted and the booking stage regenerated to meet it; the null finding was dropped
  assert.ok(state.rules.some((r) => r.id === "rarely_full" && /audit round 1/.test(r.origin)));
  assert.ok(state.rules.every((r) => !("op" in r)));
  assert.equal(state.rounds.length, 2);
  assert.deepEqual(state.rounds[0].accepted, ["full_rooms"]);
  assert.equal(state.rounds[0].flaws.length, 1);
  assert.match(state.rounds[0].flaws[0].outcome, /rule rarely_full added/);
  // round 2: a low-severity finding with a failing rule is recorded but not adopted, and the audit ends
  assert.equal(state.rounds[1].flaws.length, 1);
  assert.match(state.rounds[1].flaws[0].outcome, /not adopted/);
  assert.deepEqual(state.rounds[1].accepted, []);
  assert.ok(!state.rules.some((r) => r.id === "small_groups"));
  // every rule passes on both final databases
  for (const v of Object.values(state.verification)) for (const [id, r] of Object.entries(v)) assert.ok(r.passed, id);
  assert.ok(events.some((e) => e.type === "finished"));
  // the package, rebuilt and verified with the system Python
  // the ER diagram source is in the package, with the column-level foreign key the harness read from the schema
  assert.match(packageFiles(state)["er_diagram.mmd"], /room \|\|--o\{ booking : "room_id"/);
  const dir = mkdtempSync(join(tmpdir(), "sdb-"));
  for (const [name, content] of Object.entries(packageFiles(state))) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const seed = Number(Object.keys(state.databases)[0]);
  const gen = execFileSync("python", [join(dir, "generate.py"), "--seed", String(seed), "--out", join(dir, "rebuilt.sqlite")]).toString();
  assert.match(gen, /identical to database\.sqlite, row for row/);
  const ok = execFileSync("python", [join(dir, "verify.py"), join(dir, "rebuilt.sqlite")]).toString();
  assert.match(ok, /all checks pass/);
  const dump = (f) => execFileSync("python", ["-c",
    "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print([c.execute(f'SELECT * FROM {t} ORDER BY 1').fetchall() for t in ('room','booking')])", f]).toString();
  assert.equal(dump(join(dir, "rebuilt.sqlite")), dump(join(dir, "database.sqlite")));
  // generate.py adds the harness's foreign-key indexes too, so a user's rebuild runs as fast as the app's
  const indexes = (f) => execFileSync("python", ["-c",
    "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(\"SELECT name, sql FROM sqlite_master WHERE type='index' ORDER BY 1\").fetchall())", f]).toString();
  assert.match(indexes(join(dir, "rebuilt.sqlite")), /sdb_fk_booking_0/);
  assert.equal(indexes(join(dir, "rebuilt.sqlite")), indexes(join(dir, "database.sqlite")));
  // generate.py notices a rebuild that differs from the shipped database
  const stagesJson = JSON.parse(readFileSync(join(dir, "generator", "stages.json"), "utf8"));
  writeFileSync(join(dir, "generator", stagesJson.stages[0].file), readFileSync(join(dir, "generator", stagesJson.stages[0].file), "utf8").replace("r.randint(20, 150)", "r.randint(21, 151)"));
  assert.throws(() => execFileSync("python", [join(dir, "generate.py"), "--seed", String(seed), "--out", join(dir, "rebuilt2.sqlite")], { stdio: "pipe" }), /differs from database\.sqlite/);
});

test("regression: a serious finding whose rule is broken gets one correction instead of being lost", async () => {
  // live run 2026-10-20: a rule raised on an empty database, the finding was rejected and the audit stopped
  const llm = scriptedModel({ brokenRuleFirst: true });
  const p = new Pipeline({ llm, runtime: rt, runId: "test-run-3", settings: { auditRounds: 2 } });
  const state = await p.run("A small venue with meeting rooms and bookings of groups that fit the rooms.");
  assert.equal(llm.seen.corrections, 1);
  assert.deepEqual(state.rounds[0].accepted, ["full_rooms"]);
  assert.match(state.rounds[0].flaws[0].reason, /after a correction; first: .*raises on an empty database/);
  assert.equal(state.rounds[0].flaws[0].severity, "medium"); // the correction cannot change the severity
  assert.ok(state.rules.some((r) => r.id === "rarely_full"));
});

test("regression: a generator that raises a diagnosis of a broken check reaches the repair step", async () => {
  // baseline 2026-10-22: 4 of 5 failed runs ended with the coder raising a correct diagnosis; repair never ran
  const llm = scriptedModel({ buggyCheck: true });
  const p = new Pipeline({ llm, runtime: rt, runId: "test-run-4", settings: { auditRounds: 1, codeAttempts: 2 } });
  const state = await p.run("A small venue with meeting rooms and bookings of groups that fit the rooms.");
  assert.equal(llm.seen.repairs, 1);
  assert.match(llm.seen.repairPrompt, /booking_count/);
  assert.match(llm.seen.repairPrompt, /counts the room table/); // the generator's diagnosis reaches the repair step
  const rule = state.rules.find((r) => r.id === "booking_count");
  assert.match(rule.code, /FROM booking/);
  for (const v of Object.values(state.verification)) for (const [id, r] of Object.entries(v)) assert.ok(r.passed, id);
});

test("regression: an auditor that never reports leaves the round marked incomplete, not clean", async () => {
  // root cause: a missing report was read as an empty one ("no serious flaw found: done")
  const llm = scriptedModel({ auditorNeverReports: true });
  const p = new Pipeline({ llm, runtime: rt, runId: "test-run-2", settings: { auditRounds: 2, auditTurns: 2 } });
  const state = await p.run("A small venue with meeting rooms and bookings of groups that fit the rooms.");
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].incomplete, true);
  assert.equal(llm.seen.auditTurns, 3);
  const auditStep = state.lineage.find((s) => s.phase === "audit");
  assert.equal(auditStep.status, "info");
  assert.match(auditStep.detail, /no report/);
  assert.match(packageFiles(state)["README.md"], /not certified clean/);
});
