// A scripted model for offline tests: answers each agent by its system prompt, walking every pipeline path.
import { AUDIT_SYSTEM, CODE_SYSTEM, PLAN_SYSTEM, REPAIR_SYSTEM, SPEC_SYSTEM } from "../web/core/prompts.js";

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
// uses its seed and passes every rule, but its rows follow a set's iteration order (the reproducibility check)
const ROOMS_BY_SET = "def generate(db, rng):\n    r = rng('rooms')\n    names = {'ash', 'birch', 'cedar', 'elm', 'fir', 'hazel', 'oak', 'pine'}\n" +
  "    for i, n in enumerate(list(names)[:r.randint(4, 8)]):\n        db.execute('INSERT INTO room VALUES (?, ?)', (i + 1, 20 + len(n) * 10 + r.randint(0, 9)))\n";
// a malformed first specification: a null rule and a rule without code
const SPEC_BAD = { ...SPEC, rules: [null, { id: "room_count", statement: "x", tables: "room" }] };
// a low-severity finding whose rule fails on the data: recorded, not adopted
const LOW_RULE = { op: "add", id: "small_groups", statement: "Every booking has at most 5 people.", tables: ["booking"],
  code: "def verify_small_groups(db):\n    n = db.query('SELECT COUNT(*) FROM booking WHERE people > 5')[0][0]\n    return {'passed': n == 0, 'detail': n}" };
const BOOK_FEW = "def generate(db, rng):\n    r = rng('b')\n    rooms = db.execute('SELECT room_id, seats FROM room').fetchall()\n    for i in range(1, 11):\n        rid, s = r.choice(rooms)\n        db.execute('INSERT INTO booking VALUES (?, ?, ?)', (i, rid, r.randint(1, s)))\n";
const BOOK_OK = BOOK_FEW.replace("range(1, 11)", "range(1, r.randint(30, 60) + 1)");
// the audit's rule: groups uniformly drawn up to the room's size fill rooms past 90% ~10% of the time; real bookings
// rarely do. The revised generator caps groups at three quarters of the seats.
const BOOK_REVISED = BOOK_OK.replace("r.randint(1, s)", "r.randint(1, max(1, s * 3 // 4))");
const AUDIT_RULE = { op: "add", id: "rarely_full", statement: "At most 5% of bookings fill their room to more than 90% of its seats.", tables: ["room", "booking"],
  code: "def verify_rarely_full(db):\n    rows = db.query('SELECT b.people, r.seats FROM booking b JOIN room r USING(room_id)')\n    if not rows:\n        return {'passed': False, 'detail': 'empty'}\n    full = sum(1 for p, s in rows if p * 10 > 9 * s)\n    return {'passed': full * 20 <= len(rows), 'detail': f'{full}/{len(rows)}'}" };

// the audit rule with a bug: it divides by the row count, so it raises on an empty database
const AUDIT_RULE_BROKEN = { ...AUDIT_RULE, code: AUDIT_RULE.code.replace("    if not rows:\n        return {'passed': False, 'detail': 'empty'}\n", "").replace("full * 20 <= len(rows)", "full / len(rows) <= 0.05") };

// a specification whose booking_count check counts rooms instead of bookings (4-8 rooms can never be 30-60)
const SPEC_BUGGY_CHECK = { ...SPEC, rules: SPEC.rules.map((r) => (r.id === "booking_count" ? { ...r, code: r.code.replace("FROM booking", "FROM room") } : r)) };
// a generator that stops itself with a diagnosis of that check, as live coders do
const BOOK_DIAGNOSES = "def generate(db, rng):\n    raise ValueError('booking_count cannot be met: its check counts the room table, not bookings')\n";

// a high-severity audit rule over both tables that only the room stage can meet: one room of 170+ seats (the room
// programs draw at most 150) and one group of 140+ people. The booking stage alone cannot add seats.
const BIG_RULE = { op: "add", id: "big_hall", statement: "At least one room has 170 or more seats and at least one booking has 140 or more people.", tables: ["room", "booking"],
  code: "def verify_big_hall(db):\n    s = db.query('SELECT MAX(seats) FROM room')[0][0] or 0\n    p = db.query('SELECT MAX(people) FROM booking')[0][0] or 0\n    return {'passed': s >= 170 and p >= 140, 'detail': f'{s}/{p}'}" };
const ROOMS_HALL = ROOMS.replace("(i, r.randint(20, 150))", "(i, 180 if i == 1 else r.randint(20, 150))");
const BOOK_HALL = BOOK_OK + "    big = db.execute('SELECT room_id, seats FROM room ORDER BY seats DESC LIMIT 1').fetchone()\n" +
  "    if big[1] < 170:\n        raise ValueError('big_hall cannot be met here: no room has 170 seats')\n" +
  "    db.execute('UPDATE booking SET room_id = ?, people = 145 WHERE booking_id = 1', (big[0],))\n";

// options: auditorNeverReports - the auditor only ever queries (the incomplete-audit path);
//          brokenRuleFirst - the round-1 rule raises on an empty database until the auditor is told so;
//          buggyCheck - a specification check measures the wrong table; the booking generator raises a diagnosis
//                       until the repair step fixes the check
//          compositeRule - the audit adds big_hall, checked at the booking stage but only the room stage can meet it
//          editRetries - booking retries answer with search/replace edits (the first one does not apply)
export function scriptedModel({ auditorNeverReports = false, brokenRuleFirst = false, buggyCheck = false, compositeRule = false, editRetries = false } = {}) {
  const seen = { code: {}, audit: 0, auditTurns: 0, spec: 0, repairs: 0 };
  return {
    seen,
    usage: { calls: 0, input: 0, output: 0 },
    async research() { this.usage.calls++; return { text: "- rooms hold 20-150 people (estimate)", source: "test" }; },
    async complete({ system, messages }) {
      this.usage.calls++;
      const last = messages[messages.length - 1].content;
      if (system === SPEC_SYSTEM) return { text: "```json\n" + JSON.stringify(++seen.spec === 1 ? SPEC_BAD : buggyCheck ? SPEC_BUGGY_CHECK : SPEC) + "\n```" };
      if (system === REPAIR_SYSTEM) {
        seen.repairs++;
        seen.repairPrompt = last;
        const fixed = SPEC.rules.find((r) => r.id === "booking_count");
        return { text: JSON.stringify({ rules: [{ id: "booking_count", op: "edit", statement: fixed.statement, tables: fixed.tables, code: fixed.code }],
          reason: "the check counted rooms" }) };
      }
      if (system === PLAN_SYSTEM) return { text: JSON.stringify({ stages: [{ tables: ["room"], notes: "draw counts" }, { tables: ["booking"], notes: "fit groups" }] }) };
      if (system === CODE_SYSTEM) {
        const stage = /It writes: (\w+)/.exec(last)[1];
        const n = (seen.code[stage] = (seen.code[stage] || 0) + 1);
        if (compositeRule && /big_hall/.test(last)) {
          if (stage === "room") { seen.roomSawHall = true; return { text: "```python\n" + ROOMS_HALL + "```" }; }
          return { text: "```python\n" + BOOK_HALL + "```" };
        }
        if (stage === "room") return { text: "```python\n" + [ROOMS_FIXED, ROOMS_BY_SET, ROOMS][Math.min(n, 3) - 1] + "```" };
        if (buggyCheck && /FROM room'\)\[0\]\[0\]\\n    return \{'passed': 30|FROM room'\)\[0\]\[0\]\n    return \{'passed': 30/.test(last)) return { text: "```python\n" + BOOK_DIAGNOSES + "```" };
        if (/rarely_full/.test(last)) return { text: "```python\n" + BOOK_REVISED + "```" };
        if (editRetries && n === 2) return { text: "<<<<<<< SEARCH\nrange(1, 12)\n=======\nrange(1, 13)\n>>>>>>> REPLACE" };
        if (editRetries && n >= 3) return { text: "<<<<<<< SEARCH\n    for i in range(1, 11):\n=======\n    for i in range(1, r.randint(30, 60) + 1):\n>>>>>>> REPLACE" };
        return { text: "```python\n" + (n === 1 ? BOOK_FEW : BOOK_OK) + "```" };
      }
      if (system === AUDIT_SYSTEM) {
        seen.auditTurns++;
        if (auditorNeverReports) return { text: JSON.stringify({ action: "query", seed: 0, sql: "SELECT 1" }) };
        if (/^Some findings were rejected/.test(last)) {
          seen.corrections = (seen.corrections || 0) + 1;
          return { text: JSON.stringify({ action: "report", flaws: [{ id: "full_rooms", severity: "high", title: "rooms often full", evidence: "x", rule: AUDIT_RULE }] }) };
        }
        if (/^Result/.test(last)) {
          if (compositeRule) {
            const flaws = seen.audit === 1 ? [{ id: "no_big_hall", severity: "high", title: "no large venue", evidence: "max seats 150", rule: BIG_RULE }] : [];
            return { text: JSON.stringify({ action: "report", flaws }) };
          }
          const first = brokenRuleFirst ? AUDIT_RULE_BROKEN : AUDIT_RULE;
          const flaws = seen.audit === 1 ? [{ id: "full_rooms", severity: "medium", title: "rooms often full", evidence: "x", rule: first }, null]
            : [{ id: "big_groups", severity: "low", title: "groups are large", evidence: "y", rule: LOW_RULE }];
          return { text: JSON.stringify({ action: "report", flaws }) };
        }
        seen.audit++;
        return { text: JSON.stringify({ action: "query", seed: 0, sql: "SELECT COUNT(*) FROM booking" }) };
      }
      throw new Error(`unexpected system prompt: ${system.slice(0, 60)}`);
    },
  };
}

