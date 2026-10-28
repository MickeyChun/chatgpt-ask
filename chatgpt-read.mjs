// Read-only polling and error handling, shared by result reads and submission checks.
export function httpReadError(status, retryAfter = null, source = "conversation", now = Date.now()) {
  let retryAfterSec = null;
  if (typeof retryAfter === "string" && retryAfter.trim()) {
    const value = Number(retryAfter);
    if (Number.isFinite(value) && value >= 0) retryAfterSec = Math.ceil(value);
    else if (!Number.isFinite(value)) {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) retryAfterSec = Math.max(0, Math.ceil((date - now) / 1000));
    }
  }
  const state = status === 429 ? "rate_limited" : status === 401 ? "noauth" : status === 403 ? "forbidden"
    : status === 404 ? "not_found" : status === 408 || status >= 500 ? "server_error" : "http_error";
  const description = state === "rate_limited" ? "ChatGPT read rate limit reached"
    : state === "noauth" ? "ChatGPT authentication expired or is missing"
      : state === "forbidden" ? "ChatGPT denied access to this resource"
        : state === "not_found" ? "ChatGPT conversation was not found"
          : state === "server_error" ? "ChatGPT is temporarily unable to serve this read" : "ChatGPT read failed";
  return { state, status, source, retryable: state === "rate_limited" || state === "server_error", retryAfterSec, message: `${description} (HTTP ${status})` };
}

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function pollConversation({
  read, timeoutSec, stopWhen = () => false, initialSnapshot = null,
  now = Date.now, sleep = defaultSleep, random = Math.random,
  onProgress = () => {}, onRetry = () => {}, maxRetries = 3,
}) {
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new Error("timeout must be a finite nonnegative number");
  const deadline = now() + timeoutSec * 1000;
  let snapshot = initialSnapshot;
  let failures = 0;
  let signature = null;
  let interval = 5000;
  const pause = async (ms) => {
    // Keep individual waits bounded, including large server Retry-After values.
    for (let remaining = ms; remaining > 0; remaining -= Math.min(remaining, 30000)) await sleep(Math.min(remaining, 30000));
  };
  for (;;) {
    let result;
    try {
      result = snapshot ?? await read(Math.max(1, Math.min(15000, timeoutSec === 0 ? 15000 : deadline - now())));
      snapshot = null;
      if (!result || typeof result.state !== "string") throw new Error("ChatGPT returned an invalid read result");
    } catch (error) {
      result = { state: "read_error", retryable: true, message: `Could not read ChatGPT: ${error.message}` };
    }
    onProgress(result);
    // end_turn + finished_successfully already establishes completion. Never
    // discard a complete answer by issuing another HTTP request for stability.
    if (result.state === "done" || result.state === "empty") return result;
    if (result.retryable) {
      failures++;
      const backoff = Math.min(60000, 10000 * 2 ** (failures - 1));
      const delay = Math.max(backoff, (result.retryAfterSec ?? 0) * 1000) + Math.floor(random() * 1000);
      const failure = { ...result, retryAfterSec: Math.ceil(delay / 1000), retryAttempts: failures - 1 };
      if (failures > maxRetries || delay >= deadline - now()) return failure;
      onRetry(failure, delay);
      await pause(delay);
      if (now() >= deadline) return failure;
      continue;
    }
    if (["noauth", "forbidden", "not_found", "http_error", "read_error"].includes(result.state)) return result;
    if (stopWhen(result)) return result;
    failures = 0;
    const nextSignature = JSON.stringify([result.state, result.node, result.userMessageId, result.steps, result.note]);
    interval = nextSignature === signature ? Math.min(20000, Math.ceil(interval * 1.5)) : 5000;
    signature = nextSignature;
    const remaining = deadline - now();
    if (remaining <= 0) return result;
    await pause(Math.min(interval, remaining));
    if (now() >= deadline) return result;
  }
}
