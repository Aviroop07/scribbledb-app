// The deliverable: a zip a user can check without this app. generate.py rebuilds the database from the stage
// programs (same seeded streams, same write guard as the in-app harness), verify.py runs every rule on a database file.

import { assembleVerifiers } from "./pipeline.js";

export const GENERATE_PY = `"""Rebuild the database: python generate.py --seed SEED --out database.sqlite
Runs the stage programs in generator/ in order on a fresh database with schema.sql and triggers.sql - exactly as the
app did: each stage may write only its own tables; rng(name) is seeded from (seed, stage, name)."""
import argparse, hashlib, json, os, random, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WRITE = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}
DDL = {getattr(sqlite3, n) for n in dir(sqlite3)
       if n.startswith(("SQLITE_CREATE_", "SQLITE_DROP_", "SQLITE_ALTER")) or n in ("SQLITE_ATTACH", "SQLITE_DETACH")}
BLOCKED = {"foreign_keys", "ignore_check_constraints", "writable_schema", "recursive_triggers", "defer_foreign_keys",
           "legacy_alter_table", "trusted_schema", "query_only"}


def rng_factory(seed, stage):
    streams = {}
    def rng(name="main"):
        if name not in streams:
            d = hashlib.sha256(f"{seed}/{stage}/{name}".encode()).digest()
            streams[name] = random.Random(int.from_bytes(d[:8], "big"))
        return streams[name]
    return rng


def guard(allowed):
    def auth(action, arg1, arg2, dbname, source):
        if action in WRITE and arg1 not in allowed:
            return sqlite3.SQLITE_DENY
        if action in DDL:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and (arg1 or "").lower() in BLOCKED:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    return auth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--out", default="database.sqlite")
    a = ap.parse_args()
    if os.path.exists(a.out):
        os.remove(a.out)
    con = sqlite3.connect(a.out)
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(open(os.path.join(HERE, "schema.sql"), encoding="utf-8").read())
    trig = open(os.path.join(HERE, "triggers.sql"), encoding="utf-8").read()
    if trig.strip():
        con.executescript(trig)
    con.commit()
    plan = json.load(open(os.path.join(HERE, "generator", "stages.json"), encoding="utf-8"))
    for st in plan:
        ns = {"__name__": st["file"]}
        exec(compile(open(os.path.join(HERE, "generator", st["file"]), encoding="utf-8").read(), st["file"], "exec"), ns)
        random.seed(int.from_bytes(hashlib.sha256(f"{a.seed}/{st['index']}/global".encode()).digest()[:8], "big"))
        con.set_authorizer(guard(set(st["tables"])))
        ns["generate"](con, rng_factory(a.seed, st["index"]))
        con.set_authorizer(None)
        con.commit()
        print(f"stage {st['index'] + 1}: {', '.join(st['tables'])} done")
    bad = con.execute("PRAGMA foreign_key_check").fetchall()
    con.close()
    if bad:
        sys.exit(f"foreign keys broken: {bad[:5]}")
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
`;

export const VERIFY_PY = `"""Check a database against every rule: python verify.py database.sqlite
Exit code 0 when every rule and the integrity checks pass."""
import os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))


class DB:
    def __init__(self, con):
        self.con = con
    def query(self, sql, params=()):
        return self.con.execute(sql, tuple(params)).fetchall()


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "database.sqlite")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    ns = {"__name__": "verifiers"}
    exec(compile(open(os.path.join(HERE, "verifiers.py"), encoding="utf-8").read(), "verifiers.py", "exec"), ns)
    failed = 0
    for name in sorted(k for k in ns if k.startswith("verify_")):
        try:
            res = ns[name](DB(con))
            ok, detail = bool(res.get("passed")), res.get("detail", "")
        except Exception as e:
            ok, detail = False, f"raised {type(e).__name__}: {e}"
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name[7:]}: {str(detail)[:200]}")
    fk = con.execute("PRAGMA foreign_key_check").fetchall()
    integ = con.execute("PRAGMA integrity_check").fetchone()[0]
    ok = not fk and integ == "ok"
    failed += not ok
    print(f"{'PASS' if ok else 'FAIL'}  integrity: foreign_key_check {len(fk)} rows; {integ}")
    print(f"{'all checks pass' if not failed else f'{failed} checks fail'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
`;

const slug = (tables) => tables.join("_").replace(/[^a-z0-9_]/gi, "").slice(0, 40);

export function packageFiles(state, settings = {}) {
  const files = {};
  const seeds = Object.keys(state.databases).map(Number).sort((a, b) => a - b);
  files["schema.sql"] = state.schema.trim() + "\n";
  files["triggers.sql"] = (state.triggers || "").trim() + "\n";
  files["verifiers.py"] = assembleVerifiers(state.rules);
  const stages = state.stages.map((s, i) => ({ index: i, tables: s.tables, file: `stage_${String(i + 1).padStart(2, "0")}_${slug(s.tables)}.py` }));
  files["generator/stages.json"] = JSON.stringify(stages, null, 1) + "\n";
  stages.forEach((s, i) => { files[`generator/${s.file}`] = (state.codes[i] || "# this stage was not generated\n").trim() + "\n"; });
  files["generate.py"] = GENERATE_PY;
  files["verify.py"] = VERIFY_PY;
  seeds.forEach((seed, i) => { files[i === 0 ? "database.sqlite" : `database_seed_${seed}.sqlite`] = state.databases[seed]; });
  files["report.json"] = JSON.stringify({ description: state.description, seeds, verification: state.verification,
    rules: state.rules.map(({ id, statement, tables, origin }) => ({ id, statement, tables, origin })), plan: state.stages,
    audit_rounds: state.rounds, rejected_findings: state.rejected, research: state.research, settings }, null, 1) + "\n";
  files["lineage.json"] = JSON.stringify(state.lineage, null, 1) + "\n";
  files["README.md"] = readme(state, seeds, stages);
  return files;
}

function readme(state, seeds, stages) {
  if (!seeds.length) {
    return `# Partial package (the run did not finish)\n\n## The request\n\n${state.description}\n\n` +
      `The specification and the stage programs made so far are here; there is no final database. See lineage.json for where it stopped.\n`;
  }
  const v = state.verification[seeds[0]] || {};
  const rows = state.rules.map((r) => `| ${r.id} | ${v[r.id]?.passed ? "pass" : "FAIL"} | ${r.statement.replace(/\|/g, "/")} | ${r.origin} |`);
  const rounds = state.rounds.map((r) => `- Round ${r.round}: ${r.flaws.length} flaws reported; rules accepted: ${r.accepted.join(", ") || "none"}; rejected: ${r.rejected.map((x) => `${x.id} (${x.reason})`).join(", ") || "none"}`);
  return `# Generated database package

## The request

${state.description}

## What is here

- \`database.sqlite\` - the database (seed ${seeds[0]}); ${seeds.length > 1 ? `\`database_seed_${seeds[1]}.sqlite\` a second one from another seed.` : ""}
- \`schema.sql\`, \`triggers.sql\` - the SQLite DDL: tables, keys, CHECK constraints and triggers.
- \`verifiers.py\` - every rule as a function \`verify_<id>(db)\`.
- \`generator/\` - the generator, one program per stage (${stages.map((s) => s.tables.join("+")).join(" -> ")}).
- \`generate.py\` - rebuilds the database: \`python generate.py --seed ${seeds[0]} --out rebuilt.sqlite\`.
- \`verify.py\` - checks any database against every rule: \`python verify.py database.sqlite\`.
- \`report.json\`, \`lineage.json\` - every step the pipeline took, the audit rounds and the findings it rejected.

Requires only Python 3.10+ (standard library${state.codes.some((c) => /import numpy|from numpy/.test(c)) ? " and numpy" : ""}).

## Rules and their result on database.sqlite

| rule | result | statement | origin |
|---|---|---|---|
${rows.join("\n")}

Integrity (foreign keys, SQLite integrity_check): ${v.__integrity__?.passed ? "pass" : "FAIL"}.

## How the rules evolved

${rounds.join("\n") || "- No audit round ran."}
`;
}

export async function packageZip(JSZip, state, settings) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(packageFiles(state, settings))) zip.file(name, content);
  return zip;
}
