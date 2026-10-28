export class Cdp {
  constructor(url, { timeoutMs = 30000, WebSocketClass = WebSocket } = {}) {
    this.ws = new WebSocketClass(url);
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("CDP connection timed out")); this.ws.close(); }, this.timeoutMs);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP websocket error")); };
      this.ws.onclose = () => { clearTimeout(timer); reject(new Error("CDP websocket closed before connecting")); };
    });
    this.ws.onmessage = m => {
      let d;
      try { d = JSON.parse(m.data); } catch { this.failPending("Invalid CDP response"); return; }
      const pending = this.pending.get(d.id);
      if (pending) { this.pending.delete(d.id); clearTimeout(pending.timer); d.error ? pending.reject(new Error(`${pending.method}: ${d.error.message}`)) : pending.resolve(d); }
    };
    this.ws.onclose = () => this.failPending("CDP websocket closed");
    this.ws.onerror = () => this.failPending("CDP websocket error");
  }
  failPending(message) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async eval(expression) {
    const d = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.text || "evaluate failed");
    return d.result?.result?.value;
  }
  close() { this.failPending("CDP websocket closed"); try { this.ws.close(); } catch {} }
}
