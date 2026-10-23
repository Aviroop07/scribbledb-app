// The harness through the real runtime (Pyodide in a Node worker thread): spec checks, builds, the write guard,
// verification, read-only access, the profile, and the time limit.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntime } from "../../node/runtime-node.mjs";
import { TimeoutError, PyRuntime } from "../../web/core/runtime.js";

const SCHEMA = `CREATE TABLE room (room_id INTEGER PRIMARY KEY, seats INTEGER NOT NULL CHECK (seats BETWEEN 10 AND 200));
CREATE TABLE booking (booking_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES room(room_id),
  people INTEGER NOT NULL CHECK (people > 0));`;
const TRIGGERS = `CREATE TRIGGER booking_fits BEFORE INSERT ON booking
BEGIN SELECT RAISE(ABORT, 'too many people') WHERE NEW.people > (SELECT seats FROM room WHERE room_id = NEW.room_id); END;`;
const VERIFIERS = `def verify_room_count(db):
    """Between 3 and 6 rooms."""
    n = db.query("SELECT COUNT(*) FROM room")[0][0]
    return {"passed": 3 <= n <= 6, "detail": n}

def verify_busy(db):
    """At least 10 bookings."""
    n = db.query("SELECT COUNT(*) FROM booking")[0][0]
    return {"passed": n >= 10, "detail": n}
`;
const ROOMS = `def generate(db, rng):
    r = rng("rooms")
    for i in range(1, r.randint(3, 6) + 1):
        db.execute("INSERT INTO room VALUES (?, ?)", (i, r.randint(20, 120)))
`;
const BOOKINGS = `def generate(db, rng):
    r = rng("b")
    rooms = db.execute("SELECT room_id, seats FROM room").fetchall()
    for i in range(1, 21):
        rid, seats = r.choice(rooms)
        db.execute("INSERT INTO booking VALUES (?, ?, ?)", (i, rid, r.randint(1, seats)))
`;

const rt = nodeRuntime();
test.after(() => rt.close());

test("a valid specification passes, a broken one is explained", async () => {
  const ok = (await rt.call("check_spec", { schema: SCHEMA, triggers: TRIGGERS, verifiers: VERIFIERS })).result;
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepEqual(ok.rules, ["busy", "room_count"]);
  assert.deepEqual(ok.tables.find((t) => t.name === "booking").references, ["room"]);
  const bad = (await rt.call("check_spec", { schema: "CREATE TABL x", triggers: "", verifiers: VERIFIERS })).result;
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /do not load/);
  const raising = "def verify_x(db):\n    return {'passed': 1/0}\n";
  const r = (await rt.call("check_spec", { schema: SCHEMA, triggers: "", verifiers: raising })).result;
  assert.match(r.problems.join(" "), /raises on an empty database/);
});

test("a build runs the stages in order, is deterministic per seed and varies across seeds", async () => {
  const stages = [{ index: 0, tables: ["room"], code: ROOMS }, { index: 1, tables: ["booking"], code: BOOKINGS }];
  const a = await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS, stages, seed: 1 }, { wantDb: true });
  assert.equal(a.result.ok, true, JSON.stringify(a.result));
  assert.ok(a.db instanceof Uint8Array && a.db.length > 0);
  const again = await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS, stages, seed: 1 });
  assert.deepEqual(again.result.stages.map((s) => s.digest), a.result.stages.map((s) => s.digest));
  const other = await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS, stages, seed: 2 });
  assert.notEqual(other.result.stages[1].digest, a.result.stages[1].digest);
  const v = (await rt.call("verify", { verifiers: VERIFIERS }, { db: a.db })).result;
  assert.equal(v.busy.passed, true);
  assert.equal(v.__integrity__.passed, true);
});

test("the guard refuses writes to another stage's tables, DDL and disabling pragmas; triggers still fire", async () => {
  for (const code of [
    "def generate(db, rng):\n    db.execute('INSERT INTO booking VALUES (1, 1, 1)')\n",
    "def generate(db, rng):\n    db.execute('DROP TRIGGER booking_fits')\n",
    "def generate(db, rng):\n    db.execute('PRAGMA foreign_keys = OFF')\n",
  ]) {
    const r = (await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS,
      stages: [{ index: 0, tables: ["room"], code }], seed: 1 })).result;
    assert.equal(r.ok, false, code);
    assert.match(r.stages[0].error, /not authorized|prohibited/i, code);
  }
  const over = `def generate(db, rng):\n    db.execute("INSERT INTO room VALUES (1, 20)")\n    db.execute("INSERT INTO booking VALUES (1, 1, 99)")\n`;
  const r = (await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS,
    stages: [{ index: 0, tables: ["room", "booking"], code: over }], seed: 1 })).result;
  assert.equal(r.ok, false);
  assert.match(r.stages[0].error, /too many people/);
});

test("the auditor reads but cannot write; the profile and analysis work", async () => {
  const stages = [{ index: 0, tables: ["room"], code: ROOMS }, { index: 1, tables: ["booking"], code: BOOKINGS }];
  const a = await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS, stages, seed: 3 }, { wantDb: true });
  const q = (await rt.call("query", { sql: "SELECT COUNT(*) FROM booking" }, { db: a.db })).result;
  assert.deepEqual(q.rows, [[20]]);
  const w = (await rt.call("query", { sql: "DELETE FROM booking" }, { db: a.db })).result;
  assert.equal(w.ok, false);
  const p = (await rt.call("profile", {}, { db: a.db })).result;
  assert.equal(p.booking.rows, 20);
  assert.ok(p.room.columns.seats.max <= 120);
  const an = (await rt.call("analyze", { code: "print(sum(db.query('SELECT COUNT(*) FROM room')[0][0] for db in dbs.values()))" },
    { dbs: [[3, a.db]] })).result;
  assert.equal(an.ok, true);
  assert.match(an.output, /\d/);
});

// a fake worker: behave(msg, reply) decides; "never" sends nothing (a stalled start)
function fakeSpawn(plan) {
  const spawned = [];
  const spawn = () => {
    const kind = plan[Math.min(spawned.length, plan.length - 1)];
    let cb;
    const w = { kind, terminated: false,
      post: (msg) => setTimeout(() => cb({ id: msg.id, ok: true, result: kind }), 0),
      onMessage: (f) => { cb = f; if (kind === "ok") setTimeout(() => f({ type: "ready" }), 0); if (kind === "fatal") setTimeout(() => f({ type: "fatal", error: "CDN unreachable" }), 0); },
      terminate: () => { w.terminated = true; } };
    spawned.push(w);
    return w;
  };
  return { spawn, spawned };
}

test("regression: a failed start is not cached - the next call starts a fresh worker", async () => {
  const f = fakeSpawn(["fatal", "ok"]);
  const r = new PyRuntime(f.spawn);
  await assert.rejects(r.call("x", {}), /failed to start: CDN unreachable/);
  assert.equal((await r.call("x", {})).result, "ok");
  assert.equal(f.spawned.length, 2);
  assert.ok(f.spawned[0].terminated);
});

test("regression: a start that never finishes is bounded by the call's time limit", async () => {
  const f = fakeSpawn(["never", "ok"]);
  const r = new PyRuntime(f.spawn);
  await assert.rejects(r.call("x", {}, { timeoutMs: 100 }), TimeoutError);
  assert.equal((await r.call("x", {})).result, "ok");
});

test("regression: close() during a start ends the waiting call, and a closed runtime refuses calls", async () => {
  const f = fakeSpawn(["never"]);
  const r = new PyRuntime(f.spawn);
  const pending = r.call("x", {}, { timeoutMs: 60000 });
  setTimeout(() => r.close(), 20);
  await assert.rejects(pending, /runtime closed/);
  await assert.rejects(r.call("x", {}), /runtime closed/);
  assert.equal(f.spawned.length, 1);
});

test("the specification's own triggers may write other tables; the auditor may read the schema pragmas", async () => {
  const schema = "CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE tally (n INTEGER);";
  const triggers = "CREATE TRIGGER a_count AFTER INSERT ON a BEGIN UPDATE tally SET n = n + 1; END;";
  const stages = [{ index: 0, tables: ["tally"], code: "def generate(db, rng):\n    db.execute('INSERT INTO tally VALUES (0)')\n" },
    { index: 1, tables: ["a"], code: "def generate(db, rng):\n    for i in range(3):\n        db.execute('INSERT INTO a VALUES (?)', (i,))\n" }];
  const b = await rt.call("build", { schema, triggers, stages, seed: 1 }, { wantDb: true });
  assert.equal(b.result.ok, true, JSON.stringify(b.result.stages));
  assert.deepEqual((await rt.call("query", { sql: "SELECT n FROM tally" }, { db: b.db })).result.rows, [[3]]);
  const ti = (await rt.call("query", { sql: "PRAGMA table_info(a)" }, { db: b.db })).result;
  assert.equal(ti.ok, true, JSON.stringify(ti));
  assert.equal((await rt.call("query", { sql: "PRAGMA foreign_keys = OFF" }, { db: b.db })).result.ok, false);
});

test("regression: rules whose helpers or constants clash in the shared verifiers module are refused", async () => {
  const a = "LIMIT = 5\ndef _count(db):\n    return db.query('SELECT COUNT(*) FROM room')[0][0]\ndef verify_a(db):\n    return {'passed': _count(db) <= LIMIT, 'detail': ''}\n";
  const b = "LIMIT = 9\ndef _count(db):\n    return db.query('SELECT COUNT(*) FROM booking')[0][0]\ndef verify_b(db):\n    return {'passed': _count(db) <= LIMIT, 'detail': ''}\n";
  const r = (await rt.call("check_spec", { schema: SCHEMA, triggers: "", verifiers: a + b, rule_codes: [["a", a], ["b", b]] })).result;
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /both define _count/);
  assert.match(r.problems.join(" "), /both define LIMIT/);
  // the same helper twice, and shared imports, are fine
  const c = "import math\ndef _n(db):\n    return 1\ndef verify_c(db):\n    return {'passed': True, 'detail': ''}\n";
  const d = c.replace("verify_c", "verify_d");
  assert.equal((await rt.call("check_spec", { schema: SCHEMA, triggers: "", verifiers: c + d, rule_codes: [["c", c], ["d", d]] })).result.ok, true);
  const e = "def verify_e(db):\n    return {'passed': True, 'detail': ''}\ndef verify_c(db):\n    return {'passed': True, 'detail': ''}\n";
  assert.match((await rt.call("check_spec", { schema: SCHEMA, triggers: "", verifiers: c + e, rule_codes: [["c", c], ["e", e]] })).result.problems.join(" "), /belongs to another rule/);
});

test("regression: two runtimes with different string-hash seeds expose a program that depends on set order", async () => {
  // the set's iteration order changes with PYTHONHASHSEED (and between WebAssembly and native CPython)
  const bySet = "def generate(db, rng):\n    r = rng('x')\n    names = {'ash', 'birch', 'cedar', 'elm', 'fir', 'hazel', 'oak', 'pine', 'willow', 'yew'}\n" +
    "    for i, n in enumerate(names):\n        db.execute('INSERT INTO room VALUES (?, ?)', (i + 1, 10 + len(n) * r.randint(1, 3) + i))\n";
  const sorted = bySet.replace("enumerate(names)", "enumerate(sorted(names))");
  const other = nodeRuntime({ hashSeed: 1 });
  try {
    const digest = async (runtime, code) => (await runtime.call("build", { schema: SCHEMA, triggers: "", stages: [{ index: 0, tables: ["room"], code }], seed: 1 })).result.stages[0].digest;
    assert.notEqual(await digest(rt, bySet), await digest(other, bySet));
    assert.equal(await digest(rt, sorted), await digest(other, sorted));
  } finally {
    other.close();
  }
});

test("a runaway program is stopped at its time limit and the runtime recovers", async () => {
  const loop = "def generate(db, rng):\n    while True:\n        pass\n";
  await assert.rejects(rt.call("build", { schema: SCHEMA, triggers: "", stages: [{ index: 0, tables: ["room"], code: loop }],
    seed: 1 }, { timeoutMs: 8000 }), TimeoutError);
  const ok = (await rt.call("check_spec", { schema: SCHEMA, triggers: TRIGGERS, verifiers: VERIFIERS })).result;
  assert.equal(ok.ok, true);
});
