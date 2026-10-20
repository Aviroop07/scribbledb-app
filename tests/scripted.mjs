// A scripted model for offline tests: answers each agent by its system prompt, walking every pipeline path.
import { AUDIT_SYSTEM, CODE_SYSTEM, PLAN_SYSTEM, SPEC_SYSTEM } from "../web/core/prompts.js";

const SPEC = {
  schema_sql: `CREATE TABLE room (room_id INTEGER PRIMARY KEY, seats INTEGER NOT NULL CHECK (seats BETWEEN 10 AND 200));
CREATE TABLE booking (booking_id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES room(room_id),
  people INTEGER NOT NULL CHECK (people > 0));`,
  triggers_sql: `CREATE TRIGGER booking_fits BEFORE INSERT ON booking
BEGIN SELECT RAISE(ABORT, 'too many people') WHERE NEW.people > (SELECT seats FROM room WHERE room_id = NEW.room_id); END;`,
  rules: [
    { id: "room_count", statement: "Between 4 and 8 rooms.", tables: ["room"],
      code: "def verify_room_count(db):\n    n = db.query('SELECT COUNT(*) FROM room')[0][0]\n    return {'passed': 4 <= n <= 8, 'detail': n}" },
    { id: "booking_count", statement: "Between 30 and 60 bookings.", tables: ["booking"],
      code: "def verify_booking_count(db):\n    n = db.query('SELECT COUNT(*) FROM booking')[0][0]\n    return {'passed': 30 <= n <= 60, 'detail': n}" },
  ],
};
const ROOMS = "def generate(db, rng):\n    r = rng('rooms')\n    for i in range(1, r.randint(4, 8) + 1):\n        db.execute('INSERT INTO room VALUES (?, ?)', (i, r.randint(20, 150)))\n";
const ROOMS_FIXED = "def generate(db, rng):\n    for i in range(1, 6):\n        db.execute('INSERT INTO room VALUES (?, ?)', (i, 50))\n";
const BOOK_FEW = "def generate(db, rng):\n    r = rng('b')\n    rooms = db.execute('SELECT room_id, seats FROM room').fetchall()\n    for i in range(1, 11):\n        rid, s = r.choice(rooms)\n        db.execute('INSERT INTO booking VALUES (?, ?, ?)', (i, rid, r.randint(1, s)))\n";
const BOOK_OK = BOOK_FEW.replace("range(1, 11)", "range(1, r.randint(30, 60) + 1)");
// the audit's rule: groups uniformly drawn up to the room's size fill rooms past 90% ~10% of the time; real bookings
// rarely do. The revised generator caps groups at three quarters of the seats.
const BOOK_REVISED = BOOK_OK.replace("r.randint(1, s)", "r.randint(1, max(1, s * 3 // 4))");
const AUDIT_RULE = { op: "add", id: "rarely_full", statement: "At most 5% of bookings fill their room to more than 90% of its seats.", tables: ["room", "booking"],
  code: "def verify_rarely_full(db):\n    rows = db.query('SELECT b.people, r.seats FROM booking b JOIN room r USING(room_id)')\n    if not rows:\n        return {'passed': False, 'detail': 'empty'}\n    full = sum(1 for p, s in rows if p * 10 > 9 * s)\n    return {'passed': full * 20 <= len(rows), 'detail': f'{full}/{len(rows)}'}" };

export function scriptedModel() {
  const seen = { code: {}, audit: 0, auditTurns: 0 };
  return {
    seen,
    usage: { calls: 0, input: 0, output: 0 },
    async research() { this.usage.calls++; return { text: "- rooms hold 20-150 people (estimate)", source: "test" }; },
    async complete({ system, messages }) {
      this.usage.calls++;
      const last = messages[messages.length - 1].content;
      if (system === SPEC_SYSTEM) return { text: "```json\n" + JSON.stringify(SPEC) + "\n```" };
      if (system === PLAN_SYSTEM) return { text: JSON.stringify({ stages: [{ tables: ["room"], notes: "draw counts" }, { tables: ["booking"], notes: "fit groups" }] }) };
      if (system === CODE_SYSTEM) {
        const stage = /It writes: (\w+)/.exec(last)[1];
        const n = (seen.code[stage] = (seen.code[stage] || 0) + 1);
        if (stage === "room") return { text: "```python\n" + (n === 1 ? ROOMS_FIXED : ROOMS) + "```" };
        if (/rarely_full/.test(last)) return { text: "```python\n" + BOOK_REVISED + "```" };
        return { text: "```python\n" + (n === 1 ? BOOK_FEW : BOOK_OK) + "```" };
      }
      if (system === AUDIT_SYSTEM) {
        seen.auditTurns++;
        if (/^Result/.test(last)) return { text: JSON.stringify({ action: "report", flaws: seen.audit === 1 ? [{ id: "full_rooms", severity: "medium", title: "rooms often full", evidence: "x", rule: AUDIT_RULE }] : [] }) };
        seen.audit++;
        return { text: JSON.stringify({ action: "query", seed: 0, sql: "SELECT COUNT(*) FROM booking" }) };
      }
      throw new Error(`unexpected system prompt: ${system.slice(0, 60)}`);
    },
  };
}

