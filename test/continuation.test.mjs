import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = new URL("./mock-browser.mjs", import.meta.url).href;
const id = "11111111-2222-4333-8444-555555555555";

async function run(t, args, { scenario = "normal", input = null, rpc = null, promptFile = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-ask-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const eventsPath = path.join(dir, "events.jsonl");
  await writeFile(eventsPath, "", "utf8");
  if (promptFile !== null) {
    const file = path.join(dir, "prompt.txt");
    await writeFile(file, promptFile, "utf8");
    args = [...args, "--file", file];
  }
  const child = spawn(process.execPath, rpc ? ["chatgpt-ask-mcp.mjs"] : ["chatgpt-ask.mjs", "--json", "--timeout", "120", ...args], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${fixture}`, CHATGPT_TEST_SCENARIO: scenario, CHATGPT_TEST_EVENTS: eventsPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Subprocess timed out: ${stderr}`)); }, 10000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdout.on("data", (data) => {
    stdout += data;
    if (rpc && stdout.includes("\n")) child.stdin.end();
  });
  child.stderr.on("data", (data) => { stderr += data; });
  if (rpc) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, ...rpc }) + "\n");
  else child.stdin.end(input);
  const code = await completed;
  const events = (await readFile(eventsPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { code, stderr, json: stdout.trim() ? JSON.parse(stdout.trim()) : null, events };
}

test("follow-up waits for a new user message and never returns a stale previous answer", async (t) => {
  const r = await run(t, ["--conversation", id, "请展开上一条回答"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.conversationId, id);
  assert.equal(r.json.answer, "NEW ANSWER: 请展开上一条回答");
  assert.deepEqual(r.events.find((e) => e.type === "navigate"), { type: "navigate", url: `https://chatgpt.com/c/${id}` });
  assert.equal(r.events.filter((e) => e.type === "send").length, 1);
  assert.equal(r.events.find((e) => e.type === "send").continuing, true);
  assert.ok(r.events.filter((e) => e.type === "read").length >= 6);
});

test("conversation without a prompt still only reads the previous answer", async (t) => {
  const r = await run(t, ["--conversation", id]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.answer, "OLD ANSWER");
  assert.equal(r.events.some((e) => e.type === "send"), false);
});

test("a completed answer returns immediately without a second read that could be rate-limited", async (t) => {
  const r = await run(t, ["--conversation", id], { scenario: "done-then-rate-limit" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.answer, "OLD ANSWER");
  assert.equal(r.events.filter(e => e.type === 'api-read').length, 1);
});

test("MCP preserves rate-limit metadata and the same conversation id", async (t) => {
  const r = await run(t, [], { scenario: "rate-limit", rpc: { method: "tools/call", params: { name: "chatgpt_result", arguments: { conversation_id: id, wait_sec: 180 } } } });
  assert.equal(r.json.result.isError, true);
  const meta = r.json.result.structuredContent;
  assert.equal(meta.state, 'rate_limited');
  assert.equal(meta.httpStatus, 429);
  assert.equal(meta.retryable, true);
  assert.equal(meta.conversationId, id);
  assert.ok(meta.retryAfterSec >= 120);
  assert.doesNotMatch(r.json.result.content[0].text, /not found|still researching/);
  assert.equal(r.events.some(e => e.type === 'send'), false);
  assert.equal(r.events.filter(e => e.type === 'api-read').length, 2);
});

test("transient 429 and 503 responses retry read-only and return the existing answer", async (t) => {
  for (const scenario of ['rate-then-done', 'server-then-done']) {
    const r = await run(t, ["--conversation", id], { scenario });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.answer, 'OLD ANSWER');
    assert.equal(r.events.filter(e => e.type === 'api-read').length, 2);
    assert.equal(r.events.some(e => e.type === 'send'), false);
  }
});

test("authentication rate limiting is not misclassified as a sign-in failure or submitted as a follow-up", async (t) => {
  const r = await run(t, ["--conversation", id, "Do not send this"], { scenario: 'auth-rate-limit' });
  assert.equal(r.code, 1);
  assert.equal(r.json.state, 'rate_limited');
  assert.equal(r.json.source, 'auth_session');
  assert.equal(r.events.some(e => e.type === 'input' || e.type === 'send'), false);
});

test("a single-check follow-up reports pending when the backend still serves the previous turn", async (t) => {
  const r = await run(t, ["--conversation", id, "--timeout", "0", "Follow-up"]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.json.state, "pending");
  assert.equal(r.json.answer, undefined);
  assert.equal(r.json.conversationId, id);
});

test("omitting conversation still starts a new chat", async (t) => {
  const r = await run(t, ["New question"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.answer, "NEW ANSWER: New question");
  assert.equal(r.events.find((e) => e.type === "navigate").url, "https://chatgpt.com/");
  assert.equal(r.events.find((e) => e.type === "send").continuing, false);
});

test("a restored draft is replaced instead of being concatenated with the new prompt", async (t) => {
  const r = await run(t, ["Only this question"], { scenario: "restored-draft" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.answer, "NEW ANSWER: Only this question");
  assert.equal(r.events.find((e) => e.type === "send").prompt, "Only this question");
});

test("MCP submits a 995-character three-paragraph prompt without treating visual spacing as a changed draft", async (t) => {
  const prompt = ["甲".repeat(375), "乙".repeat(299), "丙".repeat(319)].join("\n");
  assert.equal(prompt.length, 995);
  const r = await run(t, [], { rpc: { method: "tools/call", params: { name: "chatgpt_ask", arguments: { prompt, wait_sec: 30 } } } });
  assert.equal(r.json.result.isError, false, r.json.result.content[0].text);
  assert.equal(r.events.find((e) => e.type === "send").prompt, prompt);
  assert.equal(r.json.result.content[0].text, `NEW ANSWER: ${prompt}`);
});

test("multiline drafts preserve blank paragraphs, indentation, and line breaks", async (t) => {
  const prompt = "请保留格式：\n\n    first line\n        second line\n\n最后一段";
  const r = await run(t, ["-"], { input: prompt });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.events.find((e) => e.type === "send").prompt, prompt);
});

test("current and localized send buttons submit through trusted mouse input", async (t) => {
  for (const scenario of ["modern-button", "localized-button", "disabled-first", "hidden-first", "invisible-first", "form-submit"]) {
    const r = await run(t, ["Follow-up"], { scenario });
    assert.equal(r.code, 0, `${scenario}: ${r.stderr}`);
    assert.equal(r.json.answer, "NEW ANSWER: Follow-up");
    assert.equal(r.events.find((e) => e.type === "send").via, "mouse", scenario);
    assert.equal(r.events.filter((e) => e.type === "submit-attempt").length, 1, scenario);
    assert.equal(r.events.some((e) => e.type === "programmatic-click"), false, scenario);
  }
});

test("an unrecognized button uses Enter once when the full draft is ready", async (t) => {
  const r = await run(t, ["Follow-up"], { scenario: "unknown-button" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.events.find((e) => e.type === "send").via, "keyboard");
  assert.equal(r.events.filter((e) => e.type === "submit-attempt").length, 1);
});

test("disabled send buttons, changed drafts, and generation in progress never trigger Enter", async (t) => {
  for (const scenario of ["disabled", "aria-disabled", "wrong-draft", "became-busy", "covered"]) {
    const r = await run(t, ["Follow-up"], { scenario });
    assert.equal(r.code, 1, `${scenario}: ${r.stderr}`);
    assert.equal(r.json.state, "error");
    assert.equal(r.events.some((e) => e.type === "submit-attempt"), false, scenario);
    assert.equal(r.events.some((e) => e.type === "close"), false, scenario);
  }
});

test("ignored submission is an error, preserves the draft, and does not retry", async (t) => {
  for (const args of [["--no-wait", "Follow-up"], ["--conversation", id, "Follow-up"]]) {
    const r = await run(t, args, { scenario: "ignored-submit" });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.json.state, "error");
    assert.match(r.json.message, /not confirmed/i);
    assert.equal(r.events.filter((e) => e.type === "submit-attempt").length, 1);
    assert.equal(r.events.some((e) => e.type === "close"), false);
  }
});

test("follow-ups support stdin, files, and conversation URLs", async (t) => {
  const stdin = await run(t, ["--conversation", `https://chatgpt.com/c/${id}?source=test`, "-"], { input: "Follow-up from stdin" });
  assert.equal(stdin.code, 0, stdin.stderr);
  assert.equal(stdin.json.answer, "NEW ANSWER: Follow-up from stdin");
  const file = await run(t, ["--conversation", id], { promptFile: "文件里的追问" });
  assert.equal(file.code, 0, file.stderr);
  assert.equal(file.json.answer, "NEW ANSWER: 文件里的追问");
});

test("no-wait confirms submission before closing the tab", async (t) => {
  const r = await run(t, ["--conversation", id, "--no-wait", "Follow-up"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.state, "started");
  assert.equal(r.json.conversationId, id);
  const acknowledged = r.events.findIndex((e) => e.type === "read" && e.user === "u2");
  assert.ok(acknowledged >= 0);
  assert.ok(acknowledged < r.events.findIndex((e) => e.type === "close"));
});

test("an unconfirmed submission returns an explicit error and is not retried", async (t) => {
  const r = await run(t, ["--conversation", id, "Follow-up"], { scenario: "unconfirmed" });
  assert.equal(r.code, 1);
  assert.equal(r.json.state, "error");
  assert.match(r.json.message, /before retrying/);
  assert.equal(r.events.filter((e) => e.type === "send").length, 1);
});

test("unfinished, inaccessible, and redirected conversations are not sent a message", async (t) => {
  for (const scenario of ["busy", "unreadable", "redirect", "signed-out"]) {
    const r = await run(t, ["--conversation", id, "Follow-up"], { scenario });
    assert.notEqual(r.code, 0, scenario);
    assert.equal(r.events.some((e) => e.type === "input" || e.type === "send"), false, scenario);
    if (scenario === "busy") assert.match(r.json.message, /previous turn is still running/);
    if (scenario === "unreadable") assert.match(r.json.message, /HTTP 404/);
  }
});

test("invalid ids and empty explicit prompts fail before accessing the browser", async (t) => {
  for (const args of [["--conversation", "invalid", "Follow-up"], ["--conversation"], ["--conversation", id, "-"]]) {
    const r = await run(t, args);
    assert.equal(r.code, 1);
    assert.deepEqual(r.events, []);
  }
});

test("MCP exposes the optional conversation_id and forwards a follow-up", async (t) => {
  const listing = await run(t, [], { rpc: { method: "tools/list" } });
  const tool = listing.json.result.tools.find((tool) => tool.name === "chatgpt_ask");
  assert.equal(tool.inputSchema.properties.conversation_id.type, "string");
  assert.deepEqual(tool.inputSchema.required, ["prompt"]);
  const r = await run(t, [], { rpc: { method: "tools/call", params: { name: "chatgpt_ask", arguments: { prompt: "MCP 追问", conversation_id: `https://chatgpt.com/c/${id}`, wait_sec: 30 } } } });
  assert.equal(r.json.result.isError, false, r.stderr);
  assert.equal(r.json.result.content[0].text, "NEW ANSWER: MCP 追问");
  assert.equal(r.json.result.structuredContent.conversationId, id);
  assert.equal(r.events.filter((e) => e.type === "send").length, 1);
});

test("MCP rejects invalid conversation ids instead of silently creating a new chat", async (t) => {
  for (const conversation_id of ["invalid", "", null]) {
    const r = await run(t, [], { rpc: { method: "tools/call", params: { name: "chatgpt_ask", arguments: { prompt: "Follow-up", conversation_id } } } });
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /conversation_id/);
    assert.deepEqual(r.events, []);
  }
});
