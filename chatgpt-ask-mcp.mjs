#!/usr/bin/env node
// Minimal MCP stdio server for chatgpt-ask.mjs (send via the logged-in Oracle Chrome, read the
// answer back from ChatGPT's conversation API). No dependencies; newline-delimited JSON-RPC 2.0.
//
// Long answers (deep reasoning + web search can take 10+ minutes) must not hold one tool call
// open: chatgpt_ask waits at most `wait_sec`, then returns the conversation id; the model calls
// chatgpt_result to keep waiting. Nothing is lost if a call returns early or the client gives up.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const askScript = path.join(here, "chatgpt-ask.mjs");

const ASK_WAIT_PROP = {
  type: "number",
  description: "Max seconds to wait in this call (default 240, 30-300). If ChatGPT is still working the call returns the conversation id instead of failing.",
};
const RESULT_WAIT_PROP = {
  type: "number",
  description: "Max seconds to wait (default 420, minimum 180, maximum 420). The call returns as soon as the answer is ready, so always leave the default; shorter values are raised to 180.",
};

const TOOLS = [
  {
    name: "chatgpt_ask",
    description:
      "Ask ChatGPT (the signed-in web session in the local Oracle Chrome profile) and return its full answer, with web-search citations as [n] plus a source list. " +
      "Use for web lookups, a second opinion, or when unsure. Put all needed context in the prompt (no file access). " +
      "Quick answers take ~20-60s; deep reasoning with searches can take 10+ minutes. " +
      "If it is not finished within wait_sec this returns state=pending with a conversation_id: then call chatgpt_result ONCE with that id (do NOT resend the prompt, do NOT poll). " +
      "Uses whatever model/thinking effort is currently selected in that ChatGPT window; sends are serialized.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "The full prompt to send to ChatGPT." }, wait_sec: ASK_WAIT_PROP },
      required: ["prompt"],
    },
  },
  {
    name: "chatgpt_result",
    description:
      "Wait for and fetch the answer of an existing ChatGPT conversation by id, without sending anything. " +
      "This call itself blocks for up to ~7 minutes and returns the moment the answer is ready, so it is NOT meant to be polled: call it once, with the default wait. " +
      "If it comes back pending again, the question is simply still being researched (deep reasoning + search can take 10-15 minutes): call it once more at most, then report the status and the chatgpt.com link to the user instead of repeating checks. " +
      "Also use it to re-read an older conversation (ids from chatgpt_recent or a chatgpt.com/c/<id> URL).",
    inputSchema: {
      type: "object",
      properties: { conversation_id: { type: "string", description: "Conversation id (the part after /c/ in the URL)." }, wait_sec: RESULT_WAIT_PROP },
      required: ["conversation_id"],
    },
  },
  {
    name: "chatgpt_recent",
    description: "List the most recent ChatGPT conversations (id, title, last update) to recover a conversation whose id was lost.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many (default 10, max 50)." } } },
  },
];

function runScript(argv, stdinText, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [askScript, "--json", ...argv], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, killAfterMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, json: null, err: `failed to start chatgpt-ask: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out.trim().split("\n").pop()); } catch {}
      resolve({ code, json, err: err.trim(), out });
    });
    if (stdinText !== null) child.stdin.end(stdinText);
    else child.stdin.end();
  });
}

// ask: 30-300s (the page may need up to ~3 min to load first). result: always long, 180-420s; it
// returns as soon as the answer exists, so a long wait costs nothing and short ones only cause polling.
const clampAsk = (v) => Math.min(Math.max(Number(v) || 240, 30), 300);
const clampResult = (v) => Math.min(Math.max(Number(v) || 420, 180), 420);
// page load can take up to ~3 minutes on a bad link, on top of the wait
const killMs = (wait) => (wait + 240) * 1000;

const fmtMin = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s}s`);
const checks = new Map(); // conversationId -> number of pending replies handed out
const inflight = new Map(); // conversationId -> promise of the running chatgpt_result

function formatAnswerResult(r) {
  const j = r.json;
  if (j && j.state === "done") {
    checks.delete(j.conversationId);
    return { isError: false, text: j.answer, meta: { state: "done", conversationId: j.conversationId, model: j.model, sources: j.sources, parts: j.parts } };
  }
  if (j && j.state === "pending") {
    const p = j.progress || {};
    const n = (checks.get(j.conversationId) || 0) + 1;
    checks.set(j.conversationId, n);
    const running = p.runningSec != null ? `, asked ${fmtMin(p.runningSec)} ago` : "";
    const note = p.lastNote ? ` Latest note from ChatGPT: "${p.lastNote}".` : "";
    const url = `https://chatgpt.com/c/${j.conversationId}`;
    const advice =
      n === 1
        ? "Call chatgpt_result ONCE with this conversation_id and the default wait_sec; it blocks by itself until the answer is ready (up to ~7 min). Do not poll, do not resend the prompt."
        : n === 2
          ? "Still being researched. At most one more chatgpt_result call is reasonable; do not poll more often."
          : "STOP checking. Deep reasoning with web search commonly takes 10-15+ minutes. Tell the user it is still running, give the link, and continue with other work; fetch it later only when the user asks or the answer is needed.";
    return {
      isError: false,
      text:
        `ChatGPT is still researching (search steps so far: ${p.searchSteps ?? 0}${running}).${note}\n` +
        `conversation_id: ${j.conversationId}\nlink: ${url}\npending replies so far: ${n}\n${advice}`,
      meta: { state: "pending", conversationId: j.conversationId, url, pendingReplies: n, ...p },
    };
  }
  const why =
    r.code === 3 ? "ChatGPT page not ready or not signed in (open the Oracle Chrome window and check)" :
    j && j.state === "empty" ? "the turn finished without any text" :
    j && j.message ? j.message : `chatgpt-ask exited with code ${r.code}`;
  const tail = (r.err || r.out || "").split("\n").slice(-6).join("\n");
  return { isError: true, text: `${why}\n${tail}`.trim() };
}

let askQueue = Promise.resolve();

async function callTool(name, a) {
  if (name === "chatgpt_ask") {
    const prompt = String(a?.prompt ?? "").trim();
    if (!prompt) return { isError: true, text: "prompt is empty" };
    const w = clampAsk(a?.wait_sec);
    const run = askQueue.then(() => runScript(["--timeout", String(w), "-"], prompt, killMs(w)));
    askQueue = run.then(() => {}, () => {});
    return formatAnswerResult(await run);
  }
  if (name === "chatgpt_result") {
    const id = String(a?.conversation_id ?? "").trim().replace(/^.*\/c\//, "");
    if (!/^[0-9a-f-]{20,}$/i.test(id)) return { isError: true, text: "conversation_id must look like 6ad9d8b3-93c8-83ea-bf24-31f0ab25001d" };
    const w = clampResult(a?.wait_sec);
    // a second call for the same conversation while one is still waiting just joins it
    let p = inflight.get(id);
    if (!p) {
      p = runScript(["--conversation", id, "--timeout", String(w)], null, killMs(w)).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    return formatAnswerResult(await p);
  }
  if (name === "chatgpt_recent") {
    const n = Math.min(Math.max(Number(a?.limit) || 10, 1), 50);
    const r = await runScript(["--list", String(n)], null, 240000);
    if (r.json && r.json.state === "ok") {
      const lines = r.json.conversations.map((c) => `${c.id}  ${c.updated || ""}  ${c.title || ""}`);
      return { isError: false, text: lines.join("\n") || "(no conversations)" };
    }
    return formatAnswerResult(r);
  }
  return null;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "chatgpt-ask", version: "0.2.0" },
    });
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const r = await callTool(params?.name, params?.arguments);
    if (!r) return fail(id, -32602, `unknown tool: ${params?.name}`);
    reply(id, { isError: !!r.isError, content: [{ type: "text", text: r.text }], ...(r.meta ? { structuredContent: r.meta } : {}) });
  } else if (id !== undefined && id !== null) {
    fail(id, -32601, `method not found: ${method}`);
  } // notifications (no id) are ignored
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`bad message: ${e.message}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
