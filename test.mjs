// npm test: run agent.mjs against a fake Bitroad that refuses unsigned calls,
// and check it lists once, skips a delivered sale and delivers a paid one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAID = { id: "11111111-1111-4111-8111-111111111111", status: "paid", scope: { text: "hello brave new world" } };
const DONE = { ...PAID, id: "33333333-3333-4333-8333-333333333333", status: "delivered" };
const calls = [];
let polls = 0;
const tools = {
  seller_open_store: () => [false, { error: { code: "seller_already_registered" } }],
  services_create_listing: () => [true, { id: "22222222-2222-4222-8222-222222222222" }],
  auth_whoami: () => [true, { owned: false }],
  keys_claim_link: () => [true, { claim_url: "https://example.test/claim" }],
  services_list_my_sales: () => [true, { quotes: polls++ === 0 ? [PAID, DONE] : [] }],
  services_start_work: () => [true, {}],
  services_submit_deliverable: () => [true, {}],
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/v1/keys") return res.writeHead(201).end("{}");
    if (!String(req.headers.authorization).startsWith("Signature ")) return res.writeHead(401).end("{}");
    const m = JSON.parse(body);
    if (m.method !== "tools/call") return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));
    calls.push({ name: m.params.name, args: m.params.arguments });
    const [ok, out] = tools[m.params.name]();
    const result = { content: [{ type: "text", text: JSON.stringify(out) }], isError: !ok };
    res.setHeader("content-type", "application/json").end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const dir = mkdtempSync(join(tmpdir(), "bitroad-starter-"));
const agent = spawn(process.execPath, ["agent.mjs"], {
  env: {
    ...process.env,
    STORE_SLUG: "test-agent",
    STORE_NAME: "Test",
    POLL_SECONDS: "1",
    STATE_FILE: join(dir, "state.json"),
    BITROAD_KEY_FILE: join(dir, "key.pem"),
    BITROAD_MCP_URL: `http://127.0.0.1:${server.address().port}/api/v1/mcp`,
  },
  stdio: "ignore",
});

const deadline = Date.now() + 10_000;
while (polls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
agent.kill();
server.close();

const named = (name) => calls.filter((c) => c.name === name);
assert.equal(named("services_create_listing").length, 1, "lists the service once");
assert.deepEqual(named("services_start_work").map((c) => c.args.service_quote_id), [PAID.id], "starts only the paid sale");
const [delivery] = named("services_submit_deliverable");
assert.equal(delivery?.args.service_quote_id, PAID.id, "delivers the paid sale");
assert.deepEqual(JSON.parse(delivery.args.text), { words: 4, characters: 21 });
assert.equal(named("services_submit_deliverable").length, 1, "skips the delivered sale");
console.log("ok");
