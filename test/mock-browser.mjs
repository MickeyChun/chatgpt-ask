// Preloaded only in regression-test subprocesses. No browser or network is used.
import fs from "node:fs";
import vm from "node:vm";

const id = "11111111-2222-4333-8444-555555555555";
const scenario = process.env.CHATGPT_TEST_SCENARIO || "normal";
const eventPath = process.env.CHATGPT_TEST_EVENTS;
const record = (event) => fs.appendFileSync(eventPath, JSON.stringify(event) + "\n");
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;
let elapsed = 0;
Date.now = () => realNow() + elapsed;
globalThis.setTimeout = (fn, ms, ...args) => ms <= 60000
  ? realSetTimeout(() => { elapsed += ms; fn(...args); }, 1)
  : realSetTimeout(fn, ms, ...args);

let location = new URL("https://chatgpt.com/");
let prompt = "";
let draft = scenario === "restored-draft" ? "Previous unsent draft. " : "";
let selectedAll = false;
let sent = false;
let continuing = false;
let readsAfterSend = 0;

function conversation() {
  const user = (messageId, text, created) => ({ id: messageId, author: { role: "user" }, create_time: created, content: { content_type: "text", parts: [text] } });
  const answer = (messageId, text, done) => ({ id: messageId, author: { role: "assistant" }, content: { content_type: "text", parts: [text] }, status: done ? "finished_successfully" : "in_progress", end_turn: done });
  const mapping = {
    u1: { parent: null, message: user("u1", "Previous question", 100) },
    a1: { parent: "u1", message: answer("a1", "OLD ANSWER", scenario !== "busy") },
    abandoned: { parent: "u1", message: answer("abandoned", "UNRELATED BRANCH", true) },
  };
  let current = "a1";
  if (sent) {
    readsAfterSend++;
    // Delay backend acknowledgement, then briefly serve a stale snapshot again.
    const stale = continuing && (scenario === "unconfirmed" || readsAfterSend <= 2 || readsAfterSend === 4);
    if (!stale) {
      mapping.u2 = { parent: continuing ? "a1" : null, message: user("u2", prompt, 200) };
      mapping.a2 = { parent: "u2", message: answer("a2", `NEW ANSWER: ${prompt}`, readsAfterSend !== 3) };
      current = "a2";
    }
  }
  record({ type: "read", user: current === "a1" ? "u1" : "u2" });
  return { current_node: current, mapping, title: "Test conversation", create_time: 50, update_time: 250 };
}

let apiReads = 0;
const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body });
async function pageFetch(url) {
  if (url === "/api/auth/session") return scenario === "auth-rate-limit" ? response({}, 429, { 'retry-after': '120' }) : response(scenario === "signed-out" ? {} : { accessToken: "test-only" });
  if (url === `/backend-api/conversation/${id}`) {
    apiReads++;
    record({ type: 'api-read', count: apiReads, at: Date.now() });
    if (scenario === 'unreadable') return response({}, 404);
    if (scenario === 'forbidden') return response({}, 403);
    if (scenario === 'rate-limit' || (scenario === 'done-then-rate-limit' && apiReads > 1)) return response({}, 429, { 'retry-after': '120' });
    if (scenario === 'rate-then-done' && apiReads === 1) return response({}, 429, { 'retry-after': '20' });
    if (scenario === 'server-then-done' && apiReads === 1) return response({}, 503);
    return response(conversation());
  }
  if (url.startsWith("/backend-api/conversation/")) return response({}, 404);
  throw new Error(`Unexpected page fetch: ${url}`);
}

const form = {};
const textNode = text => ({ nodeType: 3, nodeName: '#text', nodeValue: text });
const paragraph = text => ({ nodeType: 1, nodeName: 'P', childNodes: [textNode(text)] });
const editor = {
  focus() {},
  get innerText() { return draft.replace(/\n/g, '\n\n'); },
  get childNodes() { return draft.split('\n').map(paragraph); },
  closest(selector) { return selector === "form" ? form : null; },
};
function submit(via) {
  record({ type: "submit-attempt", via });
  if (scenario === "ignored-submit") return;
  sent = true;
  draft = "";
  location = new URL(`https://chatgpt.com/c/${id}`);
  record({ type: "send", prompt, continuing, via });
}
function button(attributes, { disabled = false, hidden = false, visibility = "visible", type = "button", index = 0 } = {}) {
  return {
    id: attributes.id || "", disabled, type, form, visibility,
    getAttribute(name) { return attributes[name] ?? null; },
    getClientRects() { return hidden ? [] : [this.getBoundingClientRect()]; },
    getBoundingClientRect() { return { left: 20 + index * 100, top: 20, width: 50, height: 40 }; },
    scrollIntoView() {},
    contains(element) { return element === this; },
    // Some frontend handlers ignore programmatic clicks. Tests must require the
    // trusted CDP input path rather than assuming HTMLElement.click submitted.
    click() { record({ type: "programmatic-click" }); },
  };
}
const oldAttributes = { "data-testid": "send-button", "aria-label": "Send" };
const modernAttributes = { id: "composer-submit-button", "data-testid": "composer-submit-button", "aria-label": "Send prompt" };
let buttons = [button(oldAttributes)];
if (scenario === "modern-button") buttons = [button(modernAttributes)];
if (scenario === "localized-button") buttons = [button({ "aria-label": "发送提示" })];
if (scenario === "disabled-first") buttons = [button(oldAttributes, { disabled: true }), button(modernAttributes, { index: 1 })];
if (scenario === "hidden-first") buttons = [button(oldAttributes, { hidden: true }), button(modernAttributes, { index: 1 })];
if (scenario === "invisible-first") buttons = [button(oldAttributes, { visibility: "hidden" }), button(modernAttributes, { index: 1 })];
if (scenario === "disabled") buttons = [button(modernAttributes, { disabled: true })];
if (scenario === "aria-disabled") buttons = [button({ ...modernAttributes, "aria-disabled": "true" })];
if (scenario === "unknown-button") buttons = [button({ "aria-label": "Submit in another language" })];
if (scenario === "form-submit") buttons = [button({ "aria-label": "Submit in another language" }, { type: "submit" })];
if (scenario === "became-busy") buttons = [button({ "data-testid": "stop-button", "aria-label": "Stop streaming" })];

const document = {
  readyState: "complete",
  createRange() { return { selectNodeContents() {} }; },
  elementFromPoint(x, y) {
    if (scenario === "covered") return {};
    return buttons.find((b) => {
      const r = b.getBoundingClientRect();
      return b.getClientRects().length && b.visibility !== "hidden" && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    }) || null;
  },
  querySelector(selector) {
    if (selector !== ".ProseMirror" && selector !== "#prompt-textarea") throw new Error(`Unexpected selector: ${selector}`);
    return editor;
  },
  querySelectorAll(selector) {
    if (selector !== "button") throw new Error(`Unexpected selector: ${selector}`);
    return buttons;
  },
};

globalThis.fetch = async (url, options) => {
  const request = new URL(url);
  if (request.pathname === "/json/version") return response({});
  if (request.pathname === "/json") return response([]);
  if (request.pathname === "/json/new" && options?.method === "PUT") return response({ id: "test-tab", webSocketDebuggerUrl: "ws://test/tab" });
  if (request.pathname === "/json/close/test-tab") {
    record({ type: "close" });
    return response({});
  }
  throw new Error(`Unexpected CDP fetch: ${url}`);
};

globalThis.WebSocket = class {
  constructor() { queueMicrotask(() => this.onopen()); }
  async send(data) {
    const message = JSON.parse(data);
    let result = {};
    try {
      if (message.method === "Page.navigate") {
        continuing = message.params.url.includes("/c/");
        record({ type: "navigate", url: message.params.url });
        location = new URL(scenario === "redirect" ? "https://chatgpt.com/" : message.params.url);
      } else if (message.method === "Input.insertText") {
        prompt = selectedAll ? message.params.text : draft + message.params.text;
        selectedAll = false;
        draft = scenario === "wrong-draft" ? "a different draft" : prompt;
        record({ type: "input", prompt });
      } else if (message.method === "Input.dispatchMouseEvent") {
        if (message.params.type === "mouseReleased") {
          const target = buttons.find((b) => {
            const rect = b.getBoundingClientRect();
            return b.getClientRects().length && !b.disabled && b.getAttribute("aria-disabled") !== "true"
              && message.params.x >= rect.left && message.params.x <= rect.left + rect.width
              && message.params.y >= rect.top && message.params.y <= rect.top + rect.height;
          });
          if (target) submit("mouse");
        }
      } else if (message.method === "Input.dispatchKeyEvent") {
        if (message.params.type === "keyDown" && message.params.key === "Enter") submit("keyboard");
      } else if (message.method === "Runtime.evaluate") {
        const value = await vm.runInNewContext(message.params.expression, {
          document, location, fetch: pageFetch, AbortSignal, getComputedStyle: (b) => ({ visibility: b.visibility }),
          window: { getSelection: () => ({ removeAllRanges() {}, addRange() { selectedAll = true; } }) },
        });
        result = { result: { value } };
      } else if (message.method !== "Page.enable" && message.method !== "Runtime.enable" && message.method !== "Page.bringToFront") {
        throw new Error(`Unexpected CDP method: ${message.method}`);
      }
    } catch (error) {
      result = { exceptionDetails: { text: error.message } };
    }
    this.onmessage({ data: JSON.stringify({ id: message.id, result }) });
  }
  close() {}
};
