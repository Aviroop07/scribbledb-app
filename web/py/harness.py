"""ScribbleDB v7 runtime harness. Runs inside Pyodide (a browser Web Worker, or a Node worker thread in tests).

Every function takes and returns JSON-compatible values; databases travel as raw SQLite file bytes (sqlite3
serialize/deserialize). Nothing here calls a model: it is the deterministic side of the pipeline - it loads the
specification, builds databases from the generated stage programs, runs the verifiers, and gives the auditor
read-only access.

Generator contract (what a stage program must define):
    def generate(db, rng): ...
`db` is a sqlite3 connection to the database built so far; the stage may INSERT/UPDATE/DELETE only its own tables
(an authorizer refuses everything else: other tables, DDL, ATTACH, and the pragmas that would switch checks off).
`rng(name)` returns a random.Random seeded from (seed, stage, name) - the only randomness; the global `random` module
(and numpy's global generator, when the program imports numpy) is reseeded the same way before each stage, so a
program that uses it is still deterministic."""

import ast
import collections
import contextlib
import hashlib
import io
import json
import math
import random
import sqlite3
import statistics
import sys
import time
import traceback

WRITE_ACTIONS = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE}
DDL_ACTIONS = {
    getattr(sqlite3, name)
    for name in dir(sqlite3)
    if name.startswith(("SQLITE_CREATE_", "SQLITE_DROP_", "SQLITE_ALTER")) or name in ("SQLITE_ATTACH", "SQLITE_DETACH")
}
# pragmas a generator could use to bypass the schema's guarantees
BLOCKED_PRAGMAS = {"foreign_keys", "ignore_check_constraints", "writable_schema", "recursive_triggers",
                   "defer_foreign_keys", "legacy_alter_table", "trusted_schema", "query_only"}
READ_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
READ_PRAGMAS = {"table_info", "table_xinfo", "table_list", "foreign_key_list", "index_list", "index_info", "index_xinfo"}
MAX_DETAIL = 600


# -- databases ----------------------------------------------------------------------------------------------------


def new_db(schema: str, triggers: str) -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(schema)
    for sql in fk_indexes(con):
        con.execute(sql)
    if triggers.strip():
        con.executescript(triggers)
    con.commit()
    return con


def fk_indexes(con: sqlite3.Connection) -> list[str]:
    """CREATE INDEX statements for every foreign key no existing index or rowid key already leads with. SQLite does
    not index foreign-key columns itself, so a trigger that looks up a row's siblings (no overlapping bookings of
    one room) or a foreign-key check scans the whole table on every insert: quadratic in the rows. Indexes change
    no data; package.js's generate.py adds the same ones."""
    out = []
    for t in tables_of(con):
        cols = {r[1]: r for r in con.execute(f'PRAGMA table_info("{t}")')}
        rowid = [c for c, r in cols.items() if r[5] == 1 and r[2].upper() == "INTEGER" and sum(x[5] > 0 for x in cols.values()) == 1]
        leads = [[r[2] for r in con.execute(f'PRAGMA index_info("{i[1]}")')] for i in con.execute(f'PRAGMA index_list("{t}")')]
        fks = collections.defaultdict(list)
        for r in con.execute(f'PRAGMA foreign_key_list("{t}")'):
            fks[r[0]].append((r[1], r[3]))
        for n, (fid, pairs) in enumerate(sorted(fks.items())):
            fk = [c for _, c in sorted(pairs)]
            if fk == rowid or any(ix[: len(fk)] == fk for ix in leads):
                continue
            leads.append(fk)
            out.append(f'CREATE INDEX "sdb_fk_{t}_{n}" ON "{t}"({", ".join(chr(34) + c + chr(34) for c in fk)})')
    return out


def open_bytes(data: bytes) -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.deserialize(data)
    con.execute("PRAGMA foreign_keys = ON")
    return con


def tables_of(con: sqlite3.Connection) -> list[str]:
    rows = con.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    return [r[0] for r in rows]


def table_info(con: sqlite3.Connection) -> list[dict]:
    out = []
    for t in tables_of(con):
        cols = [{"name": r[1], "type": r[2], "notnull": bool(r[3]), "pk": bool(r[5])}
                for r in con.execute(f'PRAGMA table_info("{t}")')]
        fk_rows = con.execute(f'PRAGMA foreign_key_list("{t}")').fetchall()
        fks = sorted({r[2] for r in fk_rows})
        # column-level foreign keys (for the ER diagram): from this table's column to the referenced table's column
        links = [{"from": r[3], "table": r[2], "to": r[4]} for r in fk_rows]
        out.append({"name": t, "columns": cols, "references": [f for f in fks if f != t], "fks": links})
    return out


class DB:
    """What verifiers receive: db.query(sql, params) -> list of row tuples."""

    def __init__(self, con: sqlite3.Connection) -> None:
        self.con = con

    def query(self, sql: str, params=()) -> list[tuple]:
        return self.con.execute(sql, tuple(params)).fetchall()


def load_module(code: str, name: str) -> dict:
    ns: dict = {"__name__": name}
    exec(compile(code, name, "exec"), ns)
    return ns


def load_verifiers(code: str) -> dict:
    ns = load_module(code, "verifiers.py")
    return {k[len("verify_"):]: v for k, v in ns.items() if k.startswith("verify_") and callable(v)}


def short(text, limit: int = MAX_DETAIL) -> str:
    text = str(text)
    return text if len(text) <= limit else text[: limit // 2] + " ... " + text[-limit // 2:]


def error_text(e: BaseException) -> str:
    tb = traceback.format_exception(type(e), e, e.__traceback__)
    lines = [ln for ln in "".join(tb).splitlines() if ln.strip()]
    return short("\n".join(lines[-8:]), 1500)


# -- 1. the specification -----------------------------------------------------------------------------------------


def _top_level_defs(code: str) -> dict:
    """Names a rule's code binds at module level (functions, classes, assignments) -> a dump of the definition."""
    out = {}
    for node in ast.parse(code).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[node.name] = ast.dump(node)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        out[n.id] = ast.dump(node)
    return out


def namespace_problems(rule_codes: list) -> list[str]:
    """All rules share one module (verifiers.py): two rules that bind the same name differently would silently
    replace each other's helper or constant and change a verdict; a rule that defines another rule's verify_
    function would replace that rule. Identical duplicate helpers are harmless. Imports are not counted."""
    problems: list[str] = []
    owner: dict = {}
    for rid, code in rule_codes:
        try:
            defs = _top_level_defs(code)
        except SyntaxError as e:
            problems.append(f"rule {rid}: its code does not parse: {e}")
            continue
        for name, dump in defs.items():
            if name.startswith("verify_") and name != f"verify_{rid}":
                problems.append(f"rule {rid} defines {name}, which belongs to another rule; define only verify_{rid}")
                continue
            if name in owner and owner[name][1] != dump:
                problems.append(f"rules {owner[name][0]} and {rid} both define {name} differently (all rules share one "
                                f"module); give helpers and constants rule-specific names, e.g. _{rid}_{name.lstrip('_')}")
            owner.setdefault(name, (rid, dump))
    return problems


def check_spec(schema: str, triggers: str, verifiers: str, rule_codes: list | None = None) -> dict:
    """Does the specification load, and does every verifier run on an empty database without raising?
    rule_codes: [[id, code], ...] - the rules' separate sources, checked for clashing module-level names."""
    problems: list[str] = list(namespace_problems(rule_codes)) if rule_codes else []
    info: list[dict] = []
    try:
        con = new_db(schema, triggers)
        info = table_info(con)
        if not info:
            problems.append("the schema defines no table")
    except Exception as e:
        return {"ok": False, "problems": [f"schema.sql / triggers.sql do not load in SQLite: {e}"], "tables": [],
                "rules": []}
    rules: list[str] = []
    try:
        funcs = load_verifiers(verifiers)
        rules = sorted(funcs)
        if not funcs:
            problems.append("verifiers.py defines no verify_<id>(db) function")
        for rid, fn in sorted(funcs.items()):
            try:
                res = fn(DB(con))
                if not (isinstance(res, dict) and "passed" in res):
                    problems.append(f"verify_{rid} must return a dict with 'passed' and 'detail'")
            except Exception as e:
                problems.append(f"verify_{rid} raises on an empty database (it must return passed False instead): "
                                f"{type(e).__name__}: {e}")
    except Exception as e:
        problems.append(f"verifiers.py does not load: {error_text(e)}")
    return {"ok": not problems, "problems": problems, "tables": info, "rules": rules}


# -- 2. building a database ---------------------------------------------------------------------------------------


def rng_factory(seed: int, stage: int):
    streams: dict = {}

    def rng(name: str = "main") -> random.Random:
        if name not in streams:
            digest = hashlib.sha256(f"{seed}/{stage}/{name}".encode()).digest()
            streams[name] = random.Random(int.from_bytes(digest[:8], "big"))
        return streams[name]

    return rng


def guard(allowed: set):
    # `source` is the trigger (or view) the statement runs in: a write made by one of the specification's own
    # triggers (an AFTER INSERT trigger keeping a summary table current) is the schema's behaviour, not the stage
    # writing another stage's table, so it is allowed. DDL stays refused, so no stage can add a trigger.
    def authorizer(action, arg1, arg2, dbname, source):
        if action in WRITE_ACTIONS and arg1 not in allowed and source is None:
            return sqlite3.SQLITE_DENY
        if action in DDL_ACTIONS:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and (arg1 or "").lower() in BLOCKED_PRAGMAS:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    return authorizer


def stage_digest(con: sqlite3.Connection, tables: list[str]) -> str:
    h = hashlib.sha256()
    for t in sorted(tables):
        h.update(t.encode())
        for row in sorted(repr(r) for r in con.execute(f'SELECT * FROM "{t}"')):
            h.update(row.encode())
    return h.hexdigest()[:24]


def counts(con: sqlite3.Connection, tables: list[str]) -> dict:
    return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}


def build(schema: str, triggers: str, stages: list[dict], seed: int) -> dict:
    """Run the stage programs in order for one seed. stages: [{"index", "tables", "code"}]. Returns per-stage
    results; the database bytes are returned beside (see `build_bytes`). Stops at the first failing stage."""
    con = new_db(schema, triggers)
    out = {"seed": seed, "ok": True, "stages": []}
    for st in stages:
        rec = {"index": st["index"], "ok": False, "error": "", "seconds": 0.0, "rows": {}, "digest": "", "output": "",
               "table_digests": {}, "fixed": {}}
        out["stages"].append(rec)
        buf = io.StringIO()
        t0 = time.time()
        try:
            ns = load_module(st["code"], f"stage_{st['index'] + 1:02d}.py")  # 1-based, as the UI and the package name it
            gen = ns.get("generate")
            if not callable(gen):
                raise ValueError("the program defines no generate(db, rng) function")
            random.seed(int.from_bytes(hashlib.sha256(f"{seed}/{st['index']}/global".encode()).digest()[:8], "big"))
            np = sys.modules.get("numpy")
            if np is not None:
                np.random.seed(int.from_bytes(hashlib.sha256(f"{seed}/{st['index']}/numpy".encode()).digest()[:4], "big"))
            con.set_authorizer(guard(set(st["tables"])))
            with contextlib.redirect_stdout(buf):
                gen(con, rng_factory(seed, st["index"]))
            con.set_authorizer(None)
            con.commit()
            bad_fk = con.execute("PRAGMA foreign_key_check").fetchall()
            if bad_fk:
                raise ValueError(f"foreign keys broken after the stage: {bad_fk[:5]}")
            fixed = ns.get("FIXED", {})
            if isinstance(fixed, dict):
                rec["fixed"] = {str(k): short(v, 200) for k, v in fixed.items() if k in st["tables"]}
            rec["ok"] = True
        except Exception as e:
            con.set_authorizer(None)
            with contextlib.suppress(Exception):
                con.rollback()
            rec["error"] = error_text(e)
            out["ok"] = False
        rec["seconds"] = round(time.time() - t0, 3)
        rec["output"] = short(buf.getvalue(), 800)
        if rec["ok"]:
            rec["rows"] = counts(con, st["tables"])
            rec["digest"] = stage_digest(con, st["tables"])
            rec["table_digests"] = {t: stage_digest(con, [t]) for t in st["tables"]}
        if not out["ok"]:
            break
    global LAST_DB
    LAST_DB = con.serialize()
    con.close()
    return out


LAST_DB = b""


def last_db() -> bytes:
    return LAST_DB


# -- 3. verification ----------------------------------------------------------------------------------------------


def verify(data: bytes, verifiers: str, rule_ids=None) -> dict:
    """Every verifier (or only `rule_ids`) on a database: {id: {"passed", "detail"}}, plus integrity checks."""
    con = open_bytes(data)
    out: dict = {}
    try:
        funcs = load_verifiers(verifiers)
    except Exception as e:
        return {"__load__": {"passed": False, "detail": f"verifiers.py does not load: {error_text(e)}"}}
    for rid, fn in sorted(funcs.items()):
        if rule_ids is not None and rid not in rule_ids:
            continue
        try:
            res = fn(DB(con))
            out[rid] = {"passed": bool(res.get("passed")), "detail": short(res.get("detail", ""))}
        except Exception as e:
            out[rid] = {"passed": False, "detail": f"raised {type(e).__name__}: {short(e, 300)}"}
    fk = con.execute("PRAGMA foreign_key_check").fetchall()
    integ = con.execute("PRAGMA integrity_check").fetchone()[0]
    out["__integrity__"] = {"passed": not fk and integ == "ok", "detail": f"foreign_key_check {len(fk)} rows; {integ}"}
    con.close()
    return out


# -- 4. the auditor's read-only access ----------------------------------------------------------------------------


def read_only(action, arg1, arg2, dbname, source):
    if action in READ_ACTIONS:
        return sqlite3.SQLITE_OK
    # schema-reading pragmas, with their table argument (PRAGMA table_info(t) passes the table as arg2); a pragma
    # with "= value" is a write and is not in this list
    if action == sqlite3.SQLITE_PRAGMA and (arg1 or "").lower() in READ_PRAGMAS:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def query(data: bytes, sql: str, max_rows: int = 60) -> dict:
    con = open_bytes(data)
    con.set_authorizer(read_only)
    try:
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description or []]
        rows = cur.fetchmany(max_rows + 1)
        more = len(rows) > max_rows
        return {"ok": True, "columns": cols, "rows": [list(r) for r in rows[:max_rows]], "truncated": more}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        con.close()


def analyze(dbs: dict, code: str) -> dict:
    """Run the auditor's Python on the databases (read-only). `dbs`: {seed: bytes}. The code sees `dbs` as
    {seed: DB} and the modules statistics, math, collections; what it prints is returned."""
    cons = {}
    for seed, data in dbs.items():
        c = open_bytes(data)
        c.set_authorizer(read_only)
        cons[int(seed)] = c
    buf = io.StringIO()
    ns = {"dbs": {s: DB(c) for s, c in cons.items()}, "statistics": statistics, "math": math,
          "collections": collections, "json": json}
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "analysis.py", "exec"), ns)
        return {"ok": True, "output": short(buf.getvalue(), 6000)}
    except Exception as e:
        return {"ok": False, "output": short(buf.getvalue(), 3000), "error": error_text(e)}
    finally:
        for c in cons.values():
            c.close()


def profile(data: bytes, top: int = 8) -> dict:
    """A deterministic profile of a database: per table its row count; per column nulls, distinct values, the most
    common values with counts, numeric summaries, and the share of the most common value (a pile)."""
    con = open_bytes(data)
    out: dict = {}
    for t in tables_of(con):
        n = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        cols = {}
        for (_, name, *_rest) in con.execute(f'PRAGMA table_info("{t}")'):
            vals = [r[0] for r in con.execute(f'SELECT "{name}" FROM "{t}"')]
            nonnull = [v for v in vals if v is not None]
            common = collections.Counter(nonnull).most_common(top)
            col = {"nulls": len(vals) - len(nonnull), "distinct": len(set(nonnull)),
                   "top": [[v, c] for v, c in common],
                   "top_share": round(common[0][1] / len(nonnull), 3) if nonnull else 0.0}
            nums = [v for v in nonnull if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if nums and len(nums) == len(nonnull):
                qs = statistics.quantiles(nums, n=4) if len(nums) >= 4 else []
                col |= {"min": min(nums), "max": max(nums), "mean": round(statistics.fmean(nums), 4),
                        "quartiles": [round(q, 4) for q in qs]}
            elif nonnull:
                strs = sorted(str(v) for v in nonnull)
                col |= {"min": strs[0], "max": strs[-1]}
            cols[name] = col
        out[t] = {"rows": n, "columns": cols}
    con.close()
    return out


def same_across(profiles: dict) -> list[str]:
    """Statistics identical on every database (a fixed value set reshuffled shows up here): 'table.column: what'."""
    seeds = sorted(profiles)
    if len(seeds) < 2:
        return []
    out = []
    first = profiles[seeds[0]]
    for t, tinfo in first.items():
        for c, cinfo in tinfo["columns"].items():
            others = [profiles[s].get(t, {}).get("columns", {}).get(c) for s in seeds[1:]]
            if any(o is None for o in others) or cinfo["distinct"] <= 1:
                continue
            keys = [k for k in ("top", "min", "max", "mean", "quartiles") if k in cinfo]
            same = [k for k in keys if all(o.get(k) == cinfo.get(k) for o in others)]
            if "top" in same and len(same) == len(keys):
                out.append(f"{t}.{c}: the same values with the same counts on every database")
    return out


# -- entry point used by the worker -------------------------------------------------------------------------------


def _bytes(x) -> bytes:
    """A JS Uint8Array (a JsProxy in Pyodide) or Python bytes-like as bytes."""
    return bytes(x.to_py()) if hasattr(x, "to_py") else bytes(x)


def call(fn: str, args_json: str, db_in=None, dbs_in=None) -> str:
    """The worker's entry: `fn` with JSON arguments; `db_in` one database's bytes (as `data`), `dbs_in` a list of
    [seed, bytes] pairs (as `dbs`)."""
    args = json.loads(args_json)
    if db_in is not None:
        args["data"] = _bytes(db_in)
    if dbs_in is not None:
        pairs = dbs_in.to_py() if hasattr(dbs_in, "to_py") else dbs_in
        args["dbs"] = {int(seed): _bytes(data) for seed, data in pairs}
    result = globals()[fn](**args)
    return json.dumps(result, default=str)
