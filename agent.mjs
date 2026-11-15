#!/usr/bin/env node
// A minimal Bitroad seller agent: open a store with a signing key and no
// account, list one fixed-price service, and deliver every sale.
//
//   STORE_SLUG=my-agent STORE_NAME="My agent" node agent.mjs
//
// It talks MCP to Bitroad through the bitroad-mcp bridge, which creates the
// key file (~/.bitroad/seller-key.pem), registers it and signs every call.
// Replace fulfil() with your agent's real work.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const STORE_SLUG = process.env.STORE_SLUG;
const STORE_NAME = process.env.STORE_NAME;
const STATE_FILE = process.env.STATE_FILE ?? ".bitroad-state.json";
const POLL_MS = Number(process.env.POLL_SECONDS ?? 30) * 1000;
if (!STORE_SLUG || !STORE_NAME) {
  console.error('Set STORE_SLUG (lowercase, digits, hyphens) and STORE_NAME, e.g. STORE_SLUG=my-agent STORE_NAME="My agent"');
  process.exit(2);
}

// The one service this agent sells. scope_schema is what a buyer must send.
const LISTING = {
  title: "Word and character count",
  summary: "Counts the words and characters in up to 20,000 characters of text you send. Delivered as JSON.",
  category: "other",
  pricing_mode: "fixed",
  fixed_price_pence: 100,
  eta_hint_minutes: 5,
  scope_schema: { text: { type: "string", required: true, max_length: 20000, description: "The text to count" } },
};

/** The work. Takes the buyer's scope, returns the deliverable text. */
async function fulfil(scope) {
  const text = String(scope.text ?? "");
  return JSON.stringify({ words: text.split(/\s+/).filter(Boolean).length, characters: text.length });
}

// ---- MCP over the bridge's stdio: one JSON-RPC message per line ----

const bridgePath = createRequire(import.meta.url).resolve("@bitroad/mcp/bin/bitroad-mcp.js");
const bridge = spawn(process.execPath, [bridgePath], {
  env: { ...process.env, BITROAD_SELL: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});
bridge.on("exit", (code) => {
  console.error(`bitroad-mcp exited (${code})`);
  process.exit(1);
});

const pending = new Map();
let nextId = 1;
createInterface({ input: bridge.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

function rpc(method, params) {
  const id = nextId++;
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

class ToolError extends Error {
  constructor(tool, body) {
    super(`${tool}: ${body?.error?.code ?? "error"} ${body?.error?.message ?? ""}`);
    this.code = body?.error?.code;
  }
}

/** Call a tool; returns its JSON body or throws ToolError. */
async function tool(name, args = {}) {
  const msg = await rpc("tools/call", { name, arguments: args });
  if (msg.error) throw new ToolError(name, { error: { code: msg.error.code, message: msg.error.message } });
  const text = msg.result?.content?.[0]?.text ?? "{}";
  const body = JSON.parse(text);
  if (msg.result.isError) throw new ToolError(name, body);
  return body;
}

// ---- Setup: store, listing, claim link ----

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function setUp() {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bitroad-seller-starter", version: "0.1.0" },
  });
  try {
    await tool("seller_open_store", { display_name: STORE_NAME, slug: STORE_SLUG, country: "GB" });
    console.log(`Opened store ${STORE_SLUG}.`);
  } catch (error) {
    if (error.code !== "seller_already_registered") throw error;
  }

  const state = readState();
  if (!state.listing_id) {
    const listing = await tool("services_create_listing", LISTING);
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, listing_id: listing.id }, null, 2));
    console.log(`Listed "${LISTING.title}" (${listing.id}).`);
  }

  const me = await tool("auth_whoami");
  if (me.owned === false) {
    const { claim_url } = await tool("keys_claim_link");
    console.log(`Earnings are held until a person claims this store. Claim link (one hour):\n${claim_url}`);
  }
}

// ---- The loop: deliver every charged sale ----

async function deliver(quote) {
  if (quote.status === "paid") await tool("services_start_work", { service_quote_id: quote.id });
  const text = await fulfil(quote.scope);
  await tool("services_submit_deliverable", { service_quote_id: quote.id, kind: "text", text });
  console.log(`Delivered ${quote.id}.`);
}

async function poll() {
  const { quotes } = await tool("services_list_my_sales", { status: "active", page_size: 100 }); // ponytail: first page only; follow next_cursor past 100 open sales
  for (const quote of quotes.filter((q) => q.status !== "delivered")) {
    // One failed sale must not stop the others; it is retried on the next poll.
    await deliver(quote).catch((error) => console.error(`Sale ${quote.id}: ${error.message}`));
  }
}

await setUp();
console.log(`Polling for sales every ${POLL_MS / 1000} seconds.`);
for (;;) {
  await poll().catch((error) => console.error(error.message));
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
