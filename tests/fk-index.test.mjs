// Foreign-key indexes the harness adds before the triggers: which keys get one, and that a trigger's sibling lookup
// uses it. Regression for the time-limit failures of autotune loop 2: overlap triggers on unindexed foreign keys
// scanned the whole table per insert (a 40,000-row stage took 202-411 s; with the index 12-57 s).
import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntime } from "../node/runtime-node.mjs";

const rt = nodeRuntime();
test.after(() => rt.close());

const SCHEMA = `CREATE TABLE room (room_id INTEGER PRIMARY KEY, seats INTEGER NOT NULL);
CREATE TABLE booking (booking_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES room(room_id),
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL);
CREATE TABLE badge (room_id INTEGER PRIMARY KEY REFERENCES room(room_id), code TEXT);
CREATE TABLE seat (room_id INTEGER NOT NULL REFERENCES room(room_id), n INTEGER NOT NULL, UNIQUE (room_id, n));
CREATE TABLE part (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
CREATE TABLE use (id INTEGER PRIMARY KEY, b INTEGER, a INTEGER, FOREIGN KEY (a, b) REFERENCES part(a, b));`;
const TRIGGERS = `CREATE TRIGGER no_overlap BEFORE INSERT ON booking BEGIN
  SELECT RAISE(ABORT, 'overlap') WHERE EXISTS (SELECT 1 FROM booking s WHERE s.room_id = NEW.room_id
    AND s.start_at < NEW.end_at AND NEW.start_at < s.end_at); END;`;
const ROOMS = "def generate(db, rng):\n    for i in range(1, 6):\n        db.execute('INSERT INTO room VALUES (?, ?)', (i, 20))\n";
const BOOKINGS = "def generate(db, rng):\n    for i in range(400):\n        db.execute('INSERT INTO booking VALUES (?, ?, ?, ?)', (i + 1, i % 5 + 1, i * 10, i * 10 + 9))\n";

async function built() {
  const stages = [{ index: 0, tables: ["room"], code: ROOMS }, { index: 1, tables: ["booking"], code: BOOKINGS }];
  const { result, db } = await rt.call("build", { schema: SCHEMA, triggers: TRIGGERS, stages, seed: 1 }, { wantDb: true, code: ROOMS + BOOKINGS });
  assert.ok(result.ok, JSON.stringify(result.stages));
  return db;
}
const q = async (db, sql) => (await rt.call("query", { sql }, { db })).result;

test("every foreign key gets an index unless a rowid key or an existing index already leads with it", async () => {
  const db = await built();
  const r = await q(db, "SELECT tbl_name, name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sdb_fk_%' ORDER BY 1");
  // booking.room_id: indexed; badge.room_id is its rowid key and seat.room_id leads UNIQUE(room_id, n): no index;
  // use(a, b) is a composite key in the referenced order
  assert.deepEqual(r.rows, [["booking", "sdb_fk_booking_0"], ["use", "sdb_fk_use_0"]]);
  const cols = await q(db, "PRAGMA index_info('sdb_fk_use_0')");
  assert.ok(cols.ok, cols.error);
  assert.deepEqual(cols.rows.map((r) => r[2]), ["a", "b"]);
});

test("regression: a trigger's sibling lookup on a foreign key searches the index, not the whole table", async () => {
  const db = await built();
  const plan = await q(db, "EXPLAIN QUERY PLAN SELECT 1 FROM booking s WHERE s.room_id = 3 AND s.start_at < 100 AND 50 < s.end_at");
  assert.ok(plan.ok, plan.error);
  // the foreign-key index, or the trigger-lookup index (room_id, start_at) that also serves the range
  assert.match(JSON.stringify(plan.rows), /USING INDEX sdb_(fk_booking_0|tix_\d+)/);
  assert.doesNotMatch(JSON.stringify(plan.rows), /SCAN/);
  assert.deepEqual((await q(db, "SELECT COUNT(*) FROM booking")).rows, [[400]]);
});
