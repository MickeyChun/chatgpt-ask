import { spawn } from "node:child_process";

// Preserve the distinction between our watchdog, a signal and an ordinary exit.
export function runChild(script, argv, stdinText, killAfterMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--json", ...argv], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", timedOut = false, startError = null;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, killAfterMs);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.stdin.on("error", () => {});
    child.on("error", e => { startError = e.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out.trim().split("\n").pop()); } catch {}
      resolve({ code, signal, timedOut, startError, json, err: err.trim(), out });
    });
    child.stdin.end(stdinText ?? undefined);
  });
}

export function processFailure(r, suppliedId = null) {
  const id = r.json?.conversationId || suppliedId || /\[chatgpt-ask\] conversation ([0-9a-f-]{20,})/i.exec(r.err || "")?.[1];
  const state = r.timedOut ? "process_timeout" : r.startError ? "process_start_error" : r.signal || r.code === null ? "process_interrupted" : "process_error";
  const why = r.timedOut ? "The chatgpt-ask process exceeded its time limit and was stopped; the research status is unknown."
    : r.startError ? `Could not start chatgpt-ask: ${r.startError}`
      : r.signal ? `The chatgpt-ask process was interrupted (${r.signal}); the research status is unknown.`
        : r.code === null ? "The chatgpt-ask process ended without an exit code; the research status is unknown."
          : r.code === 3 ? "ChatGPT page not ready or not signed in (open the Oracle Chrome window and check)"
            : r.json?.message || `chatgpt-ask exited with code ${r.code}`;
  const url = id ? `https://chatgpt.com/c/${id}` : null;
  const recovery = id ? `conversation_id: ${id}\nlink: ${url}\nRead the same conversation with chatgpt_result; do not resend the prompt.`
    : "If a prompt was sent, inspect the browser or use chatgpt_recent to find its conversation before retrying; do not resend blindly.";
  const tail = (r.err || r.out || "").split("\n").slice(-6).join("\n");
  return { isError: true, text: [why, recovery, tail].filter(Boolean).join("\n"), meta: { state, ...(id ? { conversationId: id, url } : {}), ...(r.signal ? { signal: r.signal } : {}) } };
}
