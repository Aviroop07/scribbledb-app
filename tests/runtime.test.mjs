// The harness through the real runtime (Pyodide in a Node worker thread): spec checks, builds, the write guard,
// verification, read-only access, the profile, and the time limit.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntime } from "../node/runtime-node.mjs";
import { TimeoutError } from "../web/core/runtime.js";

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

test("a runaway program is stopped at its time limit and the runtime recovers", async () => {
  const loop = "def generate(db, rng):\n    while True:\n        pass\n";
  await assert.rejects(rt.call("build", { schema: SCHEMA, triggers: "", stages: [{ index: 0, tables: ["room"], code: loop }],
    seed: 1 }, { timeoutMs: 8000 }), TimeoutError);
  const ok = (await rt.call("check_spec", { schema: SCHEMA, triggers: TRIGGERS, verifiers: VERIFIERS })).result;
  assert.equal(ok.ok, true);
});
