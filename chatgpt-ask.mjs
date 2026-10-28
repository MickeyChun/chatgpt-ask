#!/usr/bin/env node
// chatgpt-ask: send a prompt through the logged-in Oracle Chrome profile and read the
// answer back from ChatGPT's conversation API instead of the page (which renders
// "This response couldn't load" on this machine even though the server has the answer).
//
// Modes
//   chatgpt-ask.mjs "prompt" | --file f | -          send, then wait up to --timeout for the answer
//   chatgpt-ask.mjs --no-wait "prompt"               send, print the conversation id, return at once
//   chatgpt-ask.mjs --conversation <id>              do not send; wait for / fetch that conversation's answer
//   chatgpt-ask.mjs --conversation <id> "prompt"     continue that conversation, then wait for the new answer
//   chatgpt-ask.mjs --list [n]                       list recent conversations (default 15)
// Options
//   --timeout <sec>   how long to wait for the answer (default 240; 0 = check once)
//   --json            machine-readable output (always one JSON object on stdout)
//   --keep-tab        do not close the tab we opened
//   --port <n>        Chrome debugging port (default 9333)
//   --profile <dir>   Chrome user-data-dir (default ~/.oracle/browser-profile)
// Exit codes: 0 done / listed, 2 still running (timeout), 3 not signed in / page not ready, 1 other error.
//
// Answer = every assistant text message of the final turn (end_turn=true), in order; the
// model may split a long answer into several. Progress messages that ChatGPT emits while it
// searches (end_turn=false, tool calls, reasoning) are not part of the answer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Cdp } from "./chatgpt-cdp.mjs";
import { composerReadyExpr, focusComposerExpr, selectComposerContentsExpr, composerStateExpr } from "./chatgpt-composer.mjs";
import { httpReadError, pollConversation } from "./chatgpt-read.mjs";

const args = process.argv.slice(2);
const opt = {
  timeout: 240, json: false, keepTab: false, port: 9333, noWait: false,
  profile: path.join(os.homedir(), ".oracle", "browser-profile"),
  file: null, conversation: null, list: null,
};
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--timeout") opt.timeout = Number(args[++i]);
  else if (a === "--json") opt.json = true;
  else if (a === "--keep-tab") opt.keepTab = true;
  else if (a === "--no-wait") opt.noWait = true;
  else if (a === "--port") opt.port = Number(args[++i]);
  else if (a === "--profile") opt.profile = args[++i];
  else if (a === "--file") opt.file = args[++i];
  else if (a === "--conversation") opt.conversation = args[++i];
  else if (a === "--list") opt.list = /^\d+$/.test(args[i + 1] || "") ? Number(args[++i]) : 15;
  else rest.push(a);
}
const base = `http://127.0.0.1:${opt.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stderr.write(`[chatgpt-ask] ${m}\n`);
const emit = (obj, text) => {
  if (opt.json) console.log(JSON.stringify(obj));
  else if (text !== undefined) console.log(text);
};

async function chromeUp() {
  try {
    const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureChrome() {
  if (await chromeUp()) return;
  const exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  log("starting Chrome with the Oracle profile");
  spawn(exe, [`--remote-debugging-port=${opt.port}`, `--user-data-dir=${opt.profile}`, "--no-first-run", "about:blank"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await chromeUp()) return;
  }
  throw new Error("Chrome did not expose the debugging port in 40s");
}

// ---- page-side snippets -----------------------------------------------------------------

const readConversationExpr = (id, previousUserId = null, timeoutMs = 15000) => `(async () => {
  try {
    const failure = (${httpReadError.toString()});
    const signal = AbortSignal.timeout(${Math.ceil(timeoutMs)});
    const auth = await fetch('/api/auth/session', { signal });
    if (!auth.ok) return JSON.stringify(failure(auth.status, auth.headers.get('Retry-After'), 'auth_session'));
    const s = await auth.json();
    if (!s.accessToken) return JSON.stringify({ state: 'noauth', retryable: false, message: 'Not signed in to ChatGPT in this Chrome profile' });
    if (${JSON.stringify(id)} === null) return JSON.stringify({ state: 'ok' });
    const r = await fetch('/backend-api/conversation/${id}', { signal, headers: { Authorization: 'Bearer ' + s.accessToken } });
    if (!r.ok) return JSON.stringify(failure(r.status, r.headers.get('Retry-After')));
    const c = await r.json();
    const map = c.mapping || {};
    const chain = [];
    for (let n = c.current_node; n && map[n]; n = map[n].parent) chain.push(map[n]);
    chain.reverse();
    const msgs = chain.map((n) => n.message).filter(Boolean);
    const role = (m) => (m.author && m.author.role) || '';
    const lastUser = msgs.map(role).lastIndexOf('user');
    const user = msgs[lastUser];
    const userMessageId = user ? user.id : null;
    if (${JSON.stringify(previousUserId)} !== null && userMessageId === ${JSON.stringify(previousUserId)}) {
      return JSON.stringify({ state: 'awaiting_user_message', userMessageId });
    }
    const after = msgs.slice(lastUser + 1);
    const textOf = (m) => (m.content && m.content.parts ? m.content.parts.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\\n') : '').trim();
    const isText = (m) => m.content && (m.content.content_type === 'text' || m.content.content_type === 'multimodal_text');
    const assistant = after.filter((m) => role(m) === 'assistant');
    const finals = assistant.filter((m) => m.status === 'finished_successfully' && m.end_turn === true && isText(m) && textOf(m));
    const last = msgs[msgs.length - 1];
    const lastIsFinal = !!last && role(last) === 'assistant' && last.end_turn === true && last.status === 'finished_successfully';
    const notes = assistant.filter((m) => m.end_turn === false && isText(m) && textOf(m));
    const note = notes.length ? textOf(notes[notes.length - 1]).replace(/\\s+/g, ' ').slice(0, 160) : '';
    const modelMsg = finals[finals.length - 1] || assistant[assistant.length - 1];
    let state = 'pending';
    if (lastIsFinal) state = finals.length ? 'done' : 'empty';
    // Web-search citations: <Cite refs={["turn1search0",...]}/> -> [n], plus a numbered source list.
    const keyOf = (e) => (e && e.ref_id ? 'turn' + e.ref_id.turn_index + e.ref_id.ref_type + e.ref_id.ref_index : null);
    const refMap = {};
    assistant.forEach((m) => ((m.metadata && m.metadata.search_result_groups) || []).forEach((g) => (g.entries || []).forEach((e) => {
      const k = keyOf(e);
      if (k && e.url) refMap[k] = { url: e.url, title: e.title || '' };
    })));
    const order = [];
    const num = {};
    let finalText = finals.map(textOf).join('\\n\\n');
    finalText = finalText.replace(/<Cite refs=\\{\\[([^\\]]*)\\]\\}\\s*\\/>/g, (all, list) => list.split(',')
      .map((s) => s.trim().replace(/"/g, '')).filter(Boolean)
      .map((r) => {
        const e = refMap[r];
        if (!e) return '';
        if (!(e.url in num)) { order.push(e); num[e.url] = order.length; }
        return '[' + num[e.url] + ']';
      }).join(''));
    finalText = finalText.replace(/<Cite ref="([^"]*)"\\s*\\/>/g, (all, r) => {
      const e = refMap[r.trim()];
      if (!e) return '';
      if (!(e.url in num)) { order.push(e); num[e.url] = order.length; }
      return '[' + num[e.url] + ']';
    });
    finalText = finalText.replace(/<text[^>]*>([\\s\\S]*?)<\\/text>/g, '$1');
    if (order.length) finalText += '\\n\\n---\\n来源：\\n' + order.map((e, i) => '[' + (i + 1) + '] ' + (e.title || e.url) + ' — ' + e.url).join('\\n');
    return JSON.stringify({
      state, userMessageId, node: c.current_node, title: c.title || '', update: c.update_time || 0, created: (user && user.create_time) || c.create_time || 0,
      steps: after.filter((m) => role(m) === 'tool').length, note,
      model: (modelMsg && modelMsg.metadata && modelMsg.metadata.model_slug) || null,
      text: finalText, parts: finals.length, sources: order.length,
    });
  } catch (e) { return JSON.stringify({ state: 'read_error', retryable: true, message: String(e) }); }
})()`;

const listConversationsExpr = (n, timeoutMs = 15000) => `(async () => {
  try {
    const failure = (${httpReadError.toString()});
    const signal = AbortSignal.timeout(${Math.ceil(timeoutMs)});
    const auth = await fetch('/api/auth/session', { signal });
    if (!auth.ok) return JSON.stringify(failure(auth.status, auth.headers.get('Retry-After'), 'auth_session'));
    const s = await auth.json();
    if (!s.accessToken) return JSON.stringify({ state: 'noauth', retryable: false, message: 'Not signed in to ChatGPT in this Chrome profile' });
    const r = await fetch('/backend-api/conversations?offset=0&limit=${n}&order=updated', { signal, headers: { Authorization: 'Bearer ' + s.accessToken } });
    if (!r.ok) return JSON.stringify(failure(r.status, r.headers.get('Retry-After'), 'conversation_list'));
    const j = await r.json();
    return JSON.stringify({ state: 'ok', items: (j.items || []).map((c) => ({ id: c.id, title: c.title, updated: c.update_time })) });
  } catch (e) { return JSON.stringify({ state: 'read_error', retryable: true, message: String(e) }); }
})()`;

// ---- tab helpers ---------------------------------------------------------------------------

// A loaded chatgpt.com tab we can run fetch() in (cookies + Cloudflare context). Reuse an
// existing one when possible; otherwise open one. `needComposer` is for sending.
async function openTab({ needComposer, conversationId = null }) {
  await ensureChrome();
  let created = null;
  let info = null;
  if (!needComposer) {
    const tabs = await fetch(`${base}/json`).then((r) => r.json());
    info = tabs.find((t) => t.type === "page" && /^https:\/\/chatgpt\.com\//.test(t.url) && t.webSocketDebuggerUrl);
  }
  if (!info) {
    created = await fetch(`${base}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
    info = created;
  }
  const tab = new Cdp(info.webSocketDebuggerUrl);
  await tab.open();
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  const close = async ({ keepTab = false } = {}) => {
    tab.close();
    if (created && !opt.keepTab && !keepTab) await fetch(`${base}/json/close/${created.id}`).catch(() => {});
  };
  if (created) {
    const targetUrl = conversationId ? `https://chatgpt.com/c/${conversationId}` : "https://chatgpt.com/";
    await tab.send("Page.navigate", { url: targetUrl });
    const readyExpr = needComposer
      ? `${composerReadyExpr}${conversationId ? ` && location.pathname.endsWith(${JSON.stringify(`/c/${conversationId}`)})` : ""}`
      : "document.readyState === 'complete' && location.hostname === 'chatgpt.com'";
    let ready = false;
    for (let attempt = 0; attempt < 3 && !ready; attempt++) {
      if (attempt > 0) {
        log(`page not ready after 60s, reloading (attempt ${attempt + 1}/3)`);
        await tab.send("Page.navigate", { url: targetUrl });
      }
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(1000);
        ready = await tab.eval(readyExpr).catch(() => false);
      }
    }
    if (!ready) {
      await close();
      const e = new Error("page not ready (signed out or Cloudflare check?)");
      e.code = 3;
      throw e;
    }
  }
  return { tab, close };
}

// Retry read-only transient failures, honoring server cooldowns and the deadline.
async function readConversation(tab, convId, timeoutSec, { previousUserId = null, stopWhen, initialSnapshot } = {}) {
  let lastNote = "";
  return pollConversation({
    read: async (timeoutMs) => JSON.parse(await tab.eval(readConversationExpr(convId, previousUserId, timeoutMs))),
    timeoutSec, stopWhen, initialSnapshot,
    onProgress: (r) => {
      const note = `${r.state} steps=${r.steps ?? "-"}${r.note ? " | " + r.note.slice(0, 80) : ""}`;
      if (note !== lastNote) { log(note); lastNote = note; }
    },
    onRetry: (r, delay) => log(`${r.state}${r.status ? ` HTTP ${r.status}` : ""}; retrying read in ${Math.ceil(delay / 1000)}s`),
  });
}

function report(convId, r, startedAt) {
  if (r.state === "done") {
    emit({ state: "done", conversationId: convId, title: r.title, model: r.model, parts: r.parts, sources: r.sources || 0, answer: r.text }, r.text);
    return 0;
  }
  if (r.state === "empty") {
    emit({ state: "empty", conversationId: convId, message: "the turn finished without any text" });
    log("the turn finished without any text");
    return 1;
  }
  if (!["pending", "awaiting_user_message"].includes(r.state)) {
    const message = r.message || `ChatGPT read failed (${r.state})`;
    emit({ ...r, conversationId: convId, message }, message);
    log(message);
    return r.state === "noauth" ? 3 : 1;
  }
  const progress = { searchSteps: r.steps ?? 0, lastNote: r.note || "", elapsedSec: Math.round((Date.now() - startedAt) / 1000) };
  if (r.created) progress.runningSec = Math.max(0, Math.round(Date.now() / 1000 - r.created)); // since the question was asked
  emit({ state: "pending", conversationId: convId, title: r.title || "", progress });
  log(`still running; conversation ${convId} (steps=${progress.searchSteps}). Fetch later: --conversation ${convId}`);
  return 2;
}

// ---- modes -------------------------------------------------------------------------------------

async function modeList() {
  const { tab, close } = await openTab({ needComposer: false });
  try {
    const r = await pollConversation({ read: async (timeoutMs) => JSON.parse(await tab.eval(listConversationsExpr(opt.list || 15, timeoutMs))), timeoutSec: opt.timeout, stopWhen: () => true });
    if (r.state !== "ok") return report(null, r, Date.now());
    const items = r.items.map((c) => ({ id: c.id, title: c.title, updated: c.updated }));
    if (opt.json) console.log(JSON.stringify({ state: "ok", conversations: items }));
    else for (const c of items) console.log(`${c.id}  ${c.updated || ""}  ${c.title || ""}`);
    return 0;
  } finally {
    await close();
  }
}

async function modeGet() {
  const startedAt = Date.now();
  const { tab, close } = await openTab({ needComposer: false });
  try {
    const r = await readConversation(tab, opt.conversation, opt.timeout);
    return report(opt.conversation, r, startedAt);
  } finally {
    await close();
  }
}

async function modeSend(prompt) {
  const startedAt = Date.now();
  const { tab, close } = await openTab({ needComposer: true, conversationId: opt.conversation });
  let preserveDraft = false;
  try {
    const auth = await readConversation(tab, opt.conversation, Math.min(opt.timeout, 60), { stopWhen: () => true });
    if (!["ok", "done", "empty", "pending"].includes(auth.state)) return report(opt.conversation, auth, startedAt);
    let previousUserId = null;
    if (opt.conversation) {
      if (auth.state !== "done" && auth.state !== "empty") {
        const message = auth.state === "pending"
          ? "the previous turn is still running; use chatgpt_result or --conversation without a prompt before sending a follow-up"
          : `conversation not readable (${auth.state}${auth.status ? `, HTTP ${auth.status}` : ""})`;
        emit({ state: "error", conversationId: opt.conversation, message });
        log(message);
        return 1;
      }
      previousUserId = auth.userMessageId;
      if (!previousUserId) throw new Error("could not identify the previous user message; nothing was sent");
    }
    await sleep(3000); // let the app finish booting before typing
    await tab.send("Page.bringToFront");
    await tab.eval(selectComposerContentsExpr);
    preserveDraft = true;
    await tab.send("Input.insertText", { text: prompt });
    await sleep(800);

    let composer = null;
    for (let i = 0; i < 30; i++) {
      composer = await tab.eval(composerStateExpr(prompt, opt.conversation));
      if (composer.state === "ready" || composer.state === "wrong_conversation" || composer.state === "draft_changed" || composer.state === "busy") break;
      await sleep(500);
    }
    if (composer.state === "ready") {
      const pointer = { x: composer.x, y: composer.y, button: "left", clickCount: 1 };
      await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", ...pointer });
      await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...pointer });
    } else if (composer.state === "missing_send_button") {
      // No submit action has been attempted. Enter is a trusted fallback only when
      // the complete draft is present and no known send button is disabled.
      log("send button not recognized; submitting with Enter");
      await tab.eval(focusComposerExpr);
      const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
    } else {
      const message = `could not submit the prompt (${composer.state}); draft tab kept open. ${JSON.stringify(composer)}`;
      emit({ state: "error", conversationId: opt.conversation, message });
      log(message);
      return 1;
    }
    log("submit action dispatched; waiting for confirmation");
    let convId = opt.conversation;
    for (let i = 0; i < 90 && !convId; i++) {
      await sleep(1000);
      const p = await tab.eval("location.pathname").catch(() => "");
      const m = /^\/c\/([0-9a-f-]{20,})/.exec(p || "");
      if (m) convId = m[1];
    }
    if (!convId) {
      const message = "Submission was not confirmed: the page never moved to a conversation URL. Draft tab kept open; inspect it before retrying.";
      emit({ state: "error", message });
      log(message);
      return 1;
    }
    log(`conversation ${convId}`);
    let submitted;
    {
      // A click/keypress is not proof of submission. Confirm persistence for both
      // new chats and follow-ups before accepting an answer or closing the tab.
      submitted = await readConversation(tab, convId, 60, { previousUserId, stopWhen: r => !!r.userMessageId && r.userMessageId !== previousUserId });
      const confirmed = !!submitted.userMessageId && submitted.userMessageId !== previousUserId;
      if (!confirmed) {
        if (!["pending", "awaiting_user_message"].includes(submitted.state)) {
          submitted.message = `${submitted.message || 'Could not confirm submission'}. Submission may have succeeded; read this same conversation before retrying the prompt.`;
          return report(convId, submitted, startedAt);
        }
        const message = "The submit action was dispatched but the new user message was not confirmed. Draft tab kept open; inspect the conversation before retrying to avoid a duplicate message.";
        emit({ state: "error", conversationId: convId, message });
        log(`${message} https://chatgpt.com/c/${convId}`);
        return 1;
      }
    }
    preserveDraft = false;
    log("submission confirmed by the conversation API");
    if (opt.noWait) {
      await sleep(3000); // give the request time to reach the server before the tab goes away
      emit({ state: "started", conversationId: convId }, `started ${convId}`);
      return 0;
    }
    const r = await readConversation(tab, convId, opt.timeout, { previousUserId, initialSnapshot: submitted });
    return report(convId, r, startedAt);
  } finally {
    await close({ keepTab: preserveDraft });
  }
}

async function main() {
  if (opt.list !== null) return modeList();
  if (opt.conversation !== null) {
    opt.conversation = String(opt.conversation ?? "").trim().replace(/^.*\/c\//, "").split(/[?#]/)[0].replace(/\/$/, "");
    if (!/^[0-9a-f-]{20,}$/i.test(opt.conversation)) throw new Error("--conversation requires a valid conversation id or ChatGPT conversation URL");
    if (!opt.file && rest.length === 0) return modeGet();
  }
  let prompt = "";
  if (opt.file) prompt = fs.readFileSync(opt.file, "utf8");
  else if (rest[0] === "-") prompt = fs.readFileSync(0, "utf8");
  else prompt = rest.join(" ");
  prompt = prompt.trim();
  if (!prompt) {
    console.error('usage: chatgpt-ask.mjs "prompt" | --file f | - | --conversation <id> | --list [n]');
    return 1;
  }
  return modeSend(prompt);
}

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(e && e.code === 3 ? 3 : 1);
  },
);
