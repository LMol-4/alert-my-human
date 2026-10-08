// Shared outbound-request helpers: every channel call is bounded by a timeout
// and retried once on transient failures so one slow/flaky provider can't hang
// or spuriously fail an alert.

export const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Collapse whitespace and cap length so provider error pages (often large HTML)
// don't bloat the alert summary.
export function truncateBody(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function normalizeError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// fetch with a per-attempt timeout and a single retry on transient failures
// (network/timeout errors, HTTP 429, or 5xx). Returns the Response for the
// caller to inspect; non-retryable statuses (e.g. 4xx) are returned as-is.
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error = new Error('request failed');

  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAY_MS);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${res.status} ${await readErrorBody(res)}`);
        continue;
      }
      return res;
    } catch (error) {
      lastError = normalizeError(error);
    }
  }

  throw lastError;
}

// Bound a non-fetch promise (e.g. an SDK call) by the same timeout.
export async function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Read only a bounded prefix of provider errors, then release the stream.
// Truncating after response.text() still buffers the entire response in memory.
export async function readErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const limit = 4096;
  let bytes = 0;
  let text = '';
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return truncateBody(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Channels use only the HTTP status, so release successful response bodies too.
export async function checkResponse(response: Response): Promise<void> {
  if (!response.ok) throw new Error(`${response.status} ${await readErrorBody(response)}`);
  await response.body?.cancel();
}
