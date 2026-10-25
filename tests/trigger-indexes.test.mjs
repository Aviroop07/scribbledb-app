// Indexes for the lookups inside triggers (web/py/harness.py trigger_indexes, and the same function in the
// package's generate.py): the per-row sibling lookups of overlap and running-total triggers get an index, the app and
// the package derive the same indexes, a primary-key lookup gets none, and a malformed trigger text yields none.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GENERATE_PY } from "../web/core/package.js";

const HARNESS = fileURLToPath(new URL("../web/py/harness.py", import.meta.url));

const SCHEMA = `CREATE TABLE agent (agent_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE shift (shift_id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agent(agent_id), day TEXT NOT NULL, start_min INTEGER, end_min INTEGER);
CREATE TABLE call (call_id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agent(agent_id), shift_id INTEGER REFERENCES shift(shift_id),
  day TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, status TEXT NOT NULL);`;
const TRIGGERS = `CREATE TRIGGER call_checks BEFORE INSERT ON call
BEGIN
  SELECT RAISE(ABORT, 'not covered') WHERE NOT EXISTS (
    SELECT 1 FROM shift s WHERE s.shift_id = NEW.shift_id AND s.agent_id = NEW.agent_id AND s.start_min <= NEW.start_min);
  SELECT RAISE(ABORT, 'overlap') WHERE EXISTS (
    SELECT 1 FROM call c WHERE c.agent_id = NEW.agent_id AND c.day = NEW.day AND c.status = 'answered'
      AND c.start_min < NEW.end_min AND c.end_min > NEW.start_min);
  SELECT RAISE(ABORT, 'too long') WHERE
    (SELECT COALESCE(SUM(c.end_min - c.start_min), 0) FROM call c WHERE c.agent_id = NEW.agent_id AND c.day = NEW.day) > 480;
END;`;

// runs a Python snippet with `ns` bound to the module (harness.py or generate.py) loaded from `path`
function py(path, body) {
  const dir = mkdtempSync(join(tmpdir(), "sdb-tix-"));
  const script = join(dir, "t.py");
  writeFileSync(script, `import importlib.util, json, sqlite3, sys\nspec = importlib.util.spec_from_file_location("m", sys.argv[1])\n` +
    `ns = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(ns)\nschema, triggers = json.loads(sys.argv[2])\n${body}\n`);
  return JSON.parse(execFileSync("python", ["-I", script, path, JSON.stringify([SCHEMA, TRIGGERS])], { encoding: "utf8" }));
}

function generatePy() {
  const dir = mkdtempSync(join(tmpdir(), "sdb-gen-"));
  const path = join(dir, "generate.py");
  writeFileSync(path, GENERATE_PY);
  return path;
}

const DERIVE = "con = sqlite3.connect(':memory:')\ncon.executescript(schema)\nfor s in ns.fk_indexes(con): con.execute(s)\n" +
  "print(json.dumps(ns.trigger_indexes(con, triggers)))";

test("trigger lookups get indexes: equality columns, then the first range column; the primary-key lookup gets none", () => {
  const got = py(HARNESS, DERIVE);
  assert.deepEqual(got, [
    'CREATE INDEX IF NOT EXISTS "sdb_tix_0" ON "call"("agent_id", "day", "status", "start_min")',
  ]);
  // the shift lookup goes through shift_id (the rowid) and the running total is served by the overlap index's prefix
});

test("the package's generate.py derives exactly the app's indexes", () => {
  assert.deepEqual(py(generatePy(), DERIVE), py(HARNESS, DERIVE));
});

test("no triggers, an unknown table or a malformed text give no index and never raise", () => {
  const body = "con = sqlite3.connect(':memory:')\ncon.executescript(schema)\n" +
    "print(json.dumps([ns.trigger_indexes(con, ''), ns.trigger_indexes(con, 'SELECT 1 FROM nope n WHERE n.a = NEW.a;'), ns.trigger_indexes(con, 'FROM (((')]))";
  assert.deepEqual(py(HARNESS, body), [[], [], []]);
  assert.deepEqual(py(generatePy(), body), [[], [], []]);
});

test("indexes change no rows: the same inserts give the same tables with and without them", () => {
  const body = `import random
def fill(con):
    r = random.Random(7)
    con.executemany("INSERT INTO agent VALUES (?, ?)", [(i, f"a{i}") for i in range(1, 6)])
    con.executemany("INSERT INTO shift VALUES (?, ?, ?, ?, ?)", [(i, (i % 5) + 1, f"d{i % 3}", 0, 600) for i in range(1, 16)])
    rows = []
    for i in range(1, 400):
        s = r.randint(1, 15); st = r.randint(0, 500)
        try:
            con.execute("INSERT INTO call VALUES (?, ?, ?, ?, ?, ?, ?)", (i, (s % 5) + 1, s, f"d{s % 3}", st, st + r.randint(1, 30), "answered"))
        except sqlite3.IntegrityError:
            pass
    return con.execute("SELECT * FROM call ORDER BY call_id").fetchall()
plain = ns.new_db(schema, "")
plain.executescript(triggers)
indexed = ns.new_db(schema, triggers)
print(json.dumps([fill(plain) == fill(indexed), len([1 for r in indexed.execute("SELECT name FROM sqlite_master WHERE name LIKE 'sdb_tix_%'")])]))`;
  assert.deepEqual(py(HARNESS, body), [true, 1]);
});
