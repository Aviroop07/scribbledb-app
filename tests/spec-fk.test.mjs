// The specification gate refuses a foreign key whose parent columns are neither the primary key nor UNIQUE: SQLite
// loads such a schema but fails every insert into the child ("foreign key mismatch"), which no repair can fix.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntime } from "../node/runtime-node.mjs";

const rt = nodeRuntime({ hashSeed: 0 });
test.after(() => rt.close());

const VERIFY = "def verify_x(db):\n    return {'passed': False, 'detail': 'empty'}\n";
const check = async (schema) => (await rt.call("check_spec", { schema, triggers: "", verifiers: VERIFY, rule_codes: [["x", VERIFY]] })).result;

test("regression: a foreign key to a non-unique column is a specification problem", async () => {
  const res = await check(`CREATE TABLE rooms (room_id INTEGER PRIMARY KEY, room_type TEXT NOT NULL);
CREATE TABLE rates (rate_id INTEGER PRIMARY KEY, room_type TEXT REFERENCES rooms(room_type));`);
  assert.equal(res.ok, false);
  assert.match(res.problems.join("\n"), /foreign key mismatch - "rates" referencing "rooms": a foreign key must reference/);
});

test("foreign keys to the primary key or to UNIQUE columns pass", async () => {
  const res = await check(`CREATE TABLE rooms (room_id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE);
CREATE TABLE a (id INTEGER PRIMARY KEY, room_id INTEGER REFERENCES rooms(room_id));
CREATE TABLE b (id INTEGER PRIMARY KEY, code TEXT REFERENCES rooms(code));
CREATE TABLE c (id INTEGER PRIMARY KEY, room_id INTEGER REFERENCES rooms);`);
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
});
