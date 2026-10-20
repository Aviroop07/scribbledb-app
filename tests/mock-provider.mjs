// An OpenAI-compatible mock provider for testing the web app in a real browser without a key:
//   node tests/mock-provider.mjs [port]  ->  provider "OpenAI-compatible", base URL http://localhost:<port>/v1
// It answers with the scripted model (tests/scripted.mjs); research questions get a fixed note.
import { createServer } from "node:http";
import { scriptedModel } from "./scripted.mjs";
import { RESEARCH_SYSTEM } from "../web/core/prompts.js";

const port = Number(process.argv[2] || 8766);
let model = scriptedModel();
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  if (req.url === "/reset") { model = scriptedModel(); res.writeHead(200, cors).end("reset"); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const data = JSON.parse(body);
    const system = data.messages.find((m) => m.role === "system")?.content || "";
    const messages = data.messages.filter((m) => m.role !== "system");
    const text = system === RESEARCH_SYSTEM ? "- groups book rooms of 20-150 seats (estimate)" : (await model.complete({ system, messages })).text;
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  } catch (e) {
    res.writeHead(500, cors).end(String(e.message));
  }
}).listen(port, () => console.log(`mock provider on http://localhost:${port}/v1`));
