// The coder's retry feedback: the newest note once, then the last evaluated program's problems - never a pile of
// "Previous problems:" (live: answers without a program stacked them six deep); an answer with neither program nor
// edits is asked for a program that raises its argument; and the repair step sees the triggers.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeRuntime } from "../node/runtime-node.mjs";
import { Pipeline } from "../web/core/pipeline.js";
import { CODE_SYSTEM, PLAN_SYSTEM, REPAIR_SYSTEM, SPEC_SYSTEM } from "../web/core/prompts.js";

const rt = nodeRuntime({ hashSeed: 0 });
const rt2 = nodeRuntime({ hashSeed: 1 });
test.after(() => { rt.close(); rt2.close(); });

const SPEC = {
  schema_sql: `CREATE TABLE room (room_id INTEGER PRIMARY KEY, seats INTEGER NOT NULL CHECK (seats BETWEEN 10 AND 200));
CREATE TABLE booking (booking_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES room(room_id), people INTEGER NOT NULL CHECK (people > 0));`,
  triggers_sql: "CREATE TRIGGER booking_fits BEFORE INSERT ON booking\nBEGIN SELECT RAISE(ABORT, 'too many people') WHERE NEW.people > (SELECT seats FROM room WHERE room_id = NEW.room_id); END;",
  rules: [
    { id: "room_count", statement: "Between 4 and 8 rooms.", tables: ["room"],
      code: "def verify_room_count(db):\n    n = db.query('SELECT COUNT(*) FROM room')[0][0]\n    return {'passed': 4 <= n <= 8, 'detail': n}" },
    { id: "booking_count", statement: "Between 30 and 60 bookings.", tables: ["booking"],
      code: "def verify_booking_count(db):\n    n = db.query('SELECT COUNT(*) FROM booking')[0][0]\n    return {'passed': 30 <= n <= 60, 'detail': n}" },
  ],
};
const ROOMS = "def generate(db, rng):\n    r = rng('rooms')\n    for i in range(1, r.randint(4, 8) + 1):\n        db.execute('INSERT INTO room VALUES (?, ?)', (i, r.randint(20, 150)))\n";
const BOOK_RAISES = "def generate(db, rng):\n    raise ValueError('booking_count cannot be met')\n";
const BOOK_OK = "def generate(db, rng):\n    r = rng('b')\n    rooms = db.execute('SELECT room_id, seats FROM room').fetchall()\n" +
  "    for i in range(1, r.randint(30, 60) + 1):\n        rid, s = r.choice(rooms)\n        db.execute('INSERT INTO booking VALUES (?, ?, ?)', (i, rid, r.randint(1, s)))\n";
const fence = (code) => "```python\n" + code + "```";

function model() {
  const booking = [fence(BOOK_RAISES), "No program can meet booking_count.", "It cannot be done.", "Still impossible.", fence(BOOK_OK)];
  const seen = { code: [], repair: [] };
  return {
    seen,
    usage: { calls: 0, input: 0, output: 0 },
    async research() { return { text: "", source: "test" }; },
    async complete({ system, messages }) {
      this.usage.calls++;
      const last = messages[messages.length - 1].content;
      if (system === SPEC_SYSTEM) return { text: JSON.stringify(SPEC) };
      if (system === PLAN_SYSTEM) return { text: JSON.stringify({ stages: [{ tables: ["room"], notes: "" }, { tables: ["booking"], notes: "" }] }) };
      if (system === REPAIR_SYSTEM) { seen.repair.push(last); return { text: JSON.stringify({ rules: [{ id: "booking_count", op: "keep" }], reason: "the rule holds" }) }; }
      if (system === CODE_SYSTEM) {
        if (/It writes: room\./.test(last)) return { text: fence(ROOMS) };
        seen.code.push(last);
        return { text: booking.shift() };
      }
      throw new Error(`unexpected system prompt: ${system.slice(0, 40)}`);
    },
  };
}

test("regression: feedback carries the newest note once and never piles up; repair sees the triggers", async () => {
  const llm = model();
  const p = new Pipeline({ llm, runtime: rt, checkRuntime: rt2, runId: "feedback-test",
    settings: { research: false, auditRounds: 0, codeAttempts: 4, repairs: 1 } });
  const state = await p.run("A small venue with meeting rooms and bookings of groups that fit the rooms.");
  assert.equal(state.codes.length, 2);
  const [, afterRaise, afterProse1, afterProse2, afterRepair] = llm.seen.code;
  // after the raising program: its problems alone
  assert.match(afterRaise, /What went wrong:\nOn seed 1 the program raised:[\s\S]*booking_count cannot be met/);
  // after each answer without a program: the request for a program, then the raising program's problems - once
  for (const prompt of [afterProse1, afterProse2]) {
    const wrong = prompt.split("What went wrong:\n")[1].split("\n\nFix the cause")[0];
    assert.match(wrong, /^Your answer held neither a program nor edits\. Answer with a program\./);
    assert.equal(wrong.split("The previous program's problems:").length, 2);
    assert.doesNotMatch(wrong, /Previous problems:/);
    assert.match(wrong, /booking_count cannot be met/);
  }
  // the repair ran (the raised program counts) and the next prompt says so once, before the same problems
  assert.equal(llm.seen.repair.length, 1);
  assert.match(llm.seen.repair[0], /Triggers:\nCREATE TRIGGER booking_fits/);
  const wrong = afterRepair.split("What went wrong:\n")[1].split("\n\nFix the cause")[0];
  assert.match(wrong, /^The rules were revised after your attempts\.\n\nThe previous program's problems:\nOn seed 1 the program raised:/);
  assert.equal(wrong.split("The rules were revised").length, 2);
});
