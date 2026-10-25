// The domain expert's expectations: one call after the specification; each stage coder sees the properties of its own
// tables; the auditor sees them all; properties naming unknown tables are dropped; an unusable answer never stops a run.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntime } from "../node/runtime-node.mjs";
import { Pipeline } from "../web/core/pipeline.js";
import { AUDIT_SYSTEM, CODE_SYSTEM, EXPECT_SYSTEM, PLAN_SYSTEM, SPEC_SYSTEM } from "../web/core/prompts.js";

const rt = nodeRuntime({ hashSeed: 0 });
const rt2 = nodeRuntime({ hashSeed: 1 });
test.after(() => { rt.close(); rt2.close(); });

const SPEC = {
  schema_sql: `CREATE TABLE room (room_id INTEGER PRIMARY KEY, seats INTEGER NOT NULL CHECK (seats BETWEEN 10 AND 200));
CREATE TABLE booking (booking_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES room(room_id), people INTEGER NOT NULL CHECK (people > 0));`,
  triggers_sql: "",
  rules: [
    { id: "room_count", statement: "Between 4 and 8 rooms.", tables: ["room"],
      code: "def verify_room_count(db):\n    n = db.query('SELECT COUNT(*) FROM room')[0][0]\n    return {'passed': 4 <= n <= 8, 'detail': n}" },
    { id: "booking_count", statement: "Between 30 and 60 bookings.", tables: ["booking"],
      code: "def verify_booking_count(db):\n    n = db.query('SELECT COUNT(*) FROM booking')[0][0]\n    return {'passed': 30 <= n <= 60, 'detail': n}" },
  ],
};
const ROOMS = "def generate(db, rng):\n    r = rng('rooms')\n    db.executemany('INSERT INTO room VALUES (?, ?)', [(i, r.randint(20, 150)) for i in range(1, r.randint(4, 8) + 1)])\n";
const BOOK = "def generate(db, rng):\n    r = rng('b')\n    rooms = db.execute('SELECT room_id, seats FROM room ORDER BY room_id').fetchall()\n" +
  "    rows = []\n    for i in range(1, r.randint(30, 60) + 1):\n        rid, s = r.choice(rooms)\n        rows.append((i, rid, r.randint(1, s)))\n" +
  "    db.executemany('INSERT INTO booking VALUES (?, ?, ?)', rows)\n";
const fence = (code) => "```python\n" + code + "```";
const EXPECTED = { expectations: [
  { tables: ["room"], property: "Room sizes cluster at a few standard capacities." },
  { tables: ["Booking", "room"], property: "Groups rarely fill a room; most use well under its seats." },
  { tables: ["nowhere"], property: "A table the schema does not have." },
  { tables: ["booking"], property: "" },
] };

function model(expectAnswer) {
  const seen = { expect: [], code: {}, audit: [] };
  return {
    seen,
    usage: { calls: 0, input: 0, output: 0 },
    async research() { return { text: "", source: "test" }; },
    async complete({ system, messages }) {
      this.usage.calls++;
      const last = messages[messages.length - 1].content;
      if (system === SPEC_SYSTEM) return { text: JSON.stringify(SPEC) };
      if (system === EXPECT_SYSTEM) { seen.expect.push(last); return { text: expectAnswer }; }
      if (system === PLAN_SYSTEM) return { text: JSON.stringify({ stages: [{ tables: ["room"], notes: "" }, { tables: ["booking"], notes: "" }] }) };
      if (system === CODE_SYSTEM) {
        const room = /It writes: room\./.test(last);
        seen.code[room ? "room" : "booking"] = last;
        return { text: fence(room ? ROOMS : BOOK) };
      }
      if (system === AUDIT_SYSTEM) { seen.audit.push(last); return { text: JSON.stringify({ action: "report", flaws: [] }) }; }
      throw new Error(`unexpected system prompt: ${system.slice(0, 40)}`);
    },
  };
}

const run = (llm, settings = {}) => new Pipeline({ llm, runtime: rt, checkRuntime: rt2, runId: "expect-test",
  settings: { research: false, auditRounds: 1, ...settings } }).run("A venue with meeting rooms and bookings of groups that fit them.");

test("expectations reach the coders of their tables and the auditor; unknown tables and empty properties are dropped", async () => {
  const llm = model(JSON.stringify(EXPECTED));
  const state = await run(llm);
  assert.equal(llm.seen.expect.length, 1);
  assert.match(llm.seen.expect[0], /Rules that already exist:\n- room_count \[room\]: Between 4 and 8 rooms\./);
  assert.deepEqual(state.expectations, [
    { tables: ["room"], property: "Room sizes cluster at a few standard capacities." },
    { tables: ["booking", "room"], property: "Groups rarely fill a room; most use well under its seats." },
  ]);
  // the room coder sees both properties (both concern room); the booking coder only the one about bookings
  assert.match(llm.seen.code.room, /What real data of this kind shows[^\n]*\n- \[room\] Room sizes cluster[^\n]*\n- \[booking, room\] Groups rarely/);
  assert.match(llm.seen.code.booking, /What real data of this kind shows[^\n]*\n- \[booking, room\] Groups rarely fill a room/);
  assert.doesNotMatch(llm.seen.code.booking, /Room sizes cluster/);
  assert.match(llm.seen.audit[0], /What a domain expert expects of real data of this kind \(check these first\):\n- \[room\] Room sizes/);
});

test("an unusable answer, or the step switched off, leaves no expectations and the run goes on", async () => {
  for (const [answer, settings] of [["no json here", {}], [JSON.stringify(EXPECTED), { expectations: false }]]) {
    const llm = model(answer);
    const state = await run(llm, settings);
    assert.deepEqual(state.expectations, []);
    assert.doesNotMatch(llm.seen.code.room, /What real data of this kind shows/);
    assert.ok(state.verification);
  }
});
