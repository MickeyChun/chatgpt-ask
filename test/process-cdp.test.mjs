import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Cdp } from "../chatgpt-cdp.mjs";
import { processFailure, runChild } from "../chatgpt-process.mjs";

const id = "11111111-2222-4333-8444-555555555555";

test("a real watchdog termination reports unknown status and retains the supplied conversation", async () => {
  const r = await runChild(fileURLToPath(new URL("./fixtures/hang.mjs", import.meta.url)), [], null, 500);
  assert.equal(r.timedOut, true);
  const result = processFailure(r, id);
  assert.equal(result.meta.state, "process_timeout");
  assert.equal(result.meta.conversationId, id);
  assert.match(result.text, /status is unknown/);
  assert.match(result.text, /chatgpt_result/);
});

test("an interrupted send recovers the conversation from the CLI log", () => {
  const result = processFailure({ code: null, signal: "SIGTERM", err: `[chatgpt-ask] conversation ${id}` });
  assert.equal(result.meta.state, "process_interrupted");
  assert.equal(result.meta.conversationId, id);
  assert.match(result.text, /do not resend/);
});

test("without a known conversation, failures provide safe recovery instructions", () => {
  const result = processFailure({ code: null, signal: null, err: "" });
  assert.equal(result.meta.state, "process_interrupted");
  assert.match(result.text, /chatgpt_recent/);
  assert.doesNotMatch(result.text, /code null/);
});

class Socket {
  constructor() { queueMicrotask(() => this.onopen()); }
  send() {}
  close() { this.onclose?.(); }
}

test("a stalled CDP request times out and clears its pending entry", async () => {
  const cdp = new Cdp("ws://test", { timeoutMs: 20, WebSocketClass: Socket });
  await cdp.open();
  await assert.rejects(cdp.send("Runtime.evaluate"), /timed out/);
  assert.equal(cdp.pending.size, 0);
  cdp.close();
});

test("a CDP disconnect rejects every in-flight request", async () => {
  const cdp = new Cdp("ws://test", { timeoutMs: 1000, WebSocketClass: Socket });
  await cdp.open();
  const a = cdp.send("A"), b = cdp.send("B");
  cdp.ws.close();
  await Promise.all([assert.rejects(a, /closed/), assert.rejects(b, /closed/)]);
  assert.equal(cdp.pending.size, 0);
});
