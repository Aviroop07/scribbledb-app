# ScribbleDB

Describe a database in plain words. An agentic pipeline turns the description into a verified SQLite package:

- `database.sqlite`: the database instance (plus a second one from another seed)
- `schema.sql` and `triggers.sql`: the SQLite DDL, with keys, CHECK constraints and triggers
- `generator/` and `generate.py`: the code that rebuilds the database from a seed, row for row
- `verifiers.py` and `verify.py`: one check per rule, all passing on the shipped databases

**Use it:** https://aviroop07.github.io/scribbledb-app/ (any browser, on desktop or Android; "Install" from the browser
menu gives an offline app). You need an API key from a model provider. Nothing else: no Python, no Docker, no server
of ours. The key goes from your browser straight to the provider.

## How it works

Everything runs in your browser. CPython and SQLite run in WebAssembly ([Pyodide](https://pyodide.org)) inside a Web Worker.

| phase | what happens |
|---|---|
| research | the model looks up what real data of this kind looks like (on the command line with a local search service: its own searches, page reads and paper lookups; else the provider's web search if it has one, else Wikipedia) |
| specify | schema, triggers and a list of rules, each with Python verifier code; checked by running them on an empty database |
| plan | the tables split into stages in foreign-key order (checked; a deterministic plan is the fallback) |
| code | one generator per stage. It must pass every rule on 3 shown seeds and 2 hidden ones. It must also use its seed: a stage whose rows are the same for every seed is rejected unless it declares its tables `FIXED`. A rule a stage cannot meet is loosened by a repair step. |
| audit | an auditor queries the databases with SQL and Python, looks for what gives the data away as generated, and adds or edits rules. A new rule is accepted only if it runs and actually fails on the current data. The affected stages are then regenerated. This repeats until no serious flaw is left or the round limit is reached. |
| verify | the final databases are built and every rule is checked again |

Every step shows in the timeline as it happens. The **Specification**, **Plan**, **Generator**, **Audit**,
**Verification** and **Research** tabs show the result.

### Safety of the generated code

Generated code only runs inside the browser sandbox. An SQLite authorizer limits each stage to writing its own
tables, with no DDL, no ATTACH and no unsafe pragmas, and each stage has a time limit.

## Providers

| provider | notes |
|---|---|
| OpenAI | Responses API (with web search); falls back to Chat Completions |
| Anthropic | Messages API (with web search), called directly from the browser |
| Google Gemini | `generateContent`, with Google Search grounding |
| OpenRouter | OpenAI-compatible |
| OpenAI-compatible | any base URL (DeepSeek, Groq, Together, a local server, ...) |

If a model rejects a setting, the pipeline drops it, retries, and records the change in the timeline. This applies
to the reasoning effort, the token-limit field name and web search. A busy provider (429/5xx) is retried with
backoff.

## Limits

- One problem must fit in browser memory (about 2-4 GB). Very large, indivisible generation problems are out of scope.
- SQLite only.
- The quality of the data depends on the model; small models fail more checks and use more calls.

## Command line (optional)

The same pipeline runs in Node, which needs nothing beyond Node 18+.

```bash
npm install
```

```bash
OPENAI_API_KEY=... node node/run.mjs --provider openai --model gpt-5-mini --description-file my_db.txt --out out
```

Options:
- `--effort none|low|medium|high`
- `--rounds N` (audit rounds)
- `--max-calls N` (model-call budget)
- `--base-url URL` (for `compatible`)

The key is read from `SCRIBBLE_API_KEY` or the provider's usual variable.

### Local web search (command line)

The research step can search the web from your machine instead of through the provider's search tool. It then
searches, reads pages and looks up papers itself, and every call it made is listed in the package's report
(`research.trail`). It needs no search API key and works with any provider.

1. Run [openserp](https://github.com/karust/openserp) (MIT, one Go binary). It drives your installed Chrome or Edge
   headless, because search engines quietly refuse plain HTTP requests after a few queries.

   ```bash
   openserp serve -c node/openserp.yaml
   ```

2. Point the runner at it:

   ```bash
   SDB_SEARCH_URL=http://127.0.0.1:7072 node node/run.mjs ...
   ```

The search goes to Bing first and to Google when Bing fails. Pages are read over plain HTTP. Papers come from
[OpenAlex](https://openalex.org), which needs no key. If the service does not answer, research uses the provider's
own search and the timeline says so. A search engine's challenge page counts as a failed search; it is never solved.

## Development

```bash
npm test
```

The tests run offline. A scripted model drives every path of the pipeline. The test package is rebuilt and verified
with the system Python to confirm that its generator reproduces the database row for row.

To try the UI without a key:
1. Run `node tests/mock-provider.mjs` and `node node/serve.mjs`.
2. Open http://localhost:8765.
3. Choose "OpenAI-compatible" with base URL `http://localhost:8766/v1`.

The site is `web/` served by GitHub Pages from the `gh-pages` branch; `npm run deploy` pushes `main` and publishes
`web/` there.

## License

MIT
