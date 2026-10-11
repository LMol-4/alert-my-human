// Shared outbound-request helper: bounded attempts, a per-attempt timeout, an
// overall deadline, and caller cancellation. Failures become DeliveryErrors with
// safe messages; request URLs (which may hold credentials) are never included.

import { setTimeout as sleep } from 'node:timers/promises';
import { DeliveryError, type ProviderOptions } from './types';

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
// Errors raised before a connection exists, so the request was never sent.
const CONNECT_ERRORS = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'];

export interface RequestOptions extends ProviderOptions {
  /** Include a truncated provider error body in messages (known providers only). */
  includeErrorBody?: boolean;
  /** Retry after a timeout or dropped connection; only safe with provider idempotency. */
  retryUnknown?: boolean;
}

// Collapse whitespace and cap length so provider error pages (often large HTML)
// don't bloat results.
export function truncateBody(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// Retry-After header in seconds, or Telegram's parameters.retry_after body field.
function retryAfterMs(response: Response, body: string): number | undefined {
  const header = Number(response.headers.get('retry-after'));
  if (header > 0) return header * 1000;
  try {
    const seconds = JSON.parse(body)?.parameters?.retry_after;
    if (seconds > 0) return seconds * 1000;
  } catch {}
}

export async function request(url: string, init: RequestInit, options: RequestOptions): Promise<Response> {
  const { signal, deadline } = options;
  let uncertain = false;
  let attempts = 0;
  const fail = (error: DeliveryError) =>
    new DeliveryError(error.code, error.message, uncertain ? 'unknown' : error.outcome, attempts, error.retryAfterMs);

  for (;;) {
    const remaining = deadline - Date.now();
    if (signal?.aborted) throw fail(new DeliveryError('ABORTED', 'Cancelled by caller', attempts ? 'rejected' : 'not_attempted'));
    if (remaining <= 0) throw fail(new DeliveryError('TIMEOUT', 'Deadline passed before sending', attempts ? 'rejected' : 'not_attempted'));

    attempts++;
    let error: DeliveryError;
    let wait = RETRY_DELAY_MS * 2 ** (attempts - 1);
    try {
      const timeout = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining));
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.ok) return response;
      const body = await readErrorBody(response);
      const detail = options.includeErrorBody && body ? `: ${body}` : '';
      if (response.status === 429) {
        const after = retryAfterMs(response, body);
        error = new DeliveryError('RATE_LIMITED', `Provider rate limit (HTTP 429)${detail}`, 'rejected', attempts, after);
        if (after !== undefined) wait = after;
      } else {
        error = new DeliveryError('HTTP_ERROR', `HTTP ${response.status}${detail}`, 'rejected', attempts);
        if (response.status < 500) throw fail(error);
      }
    } catch (caught) {
      if (caught instanceof DeliveryError) throw caught;
      if (signal?.aborted) {
        uncertain = true;
        throw fail(new DeliveryError('ABORTED', 'Cancelled by caller during the request'));
      }
      const name = (caught as Error)?.name;
      const code = ((caught as Error)?.cause as { code?: string })?.code;
      if (name === 'TimeoutError') {
        error = new DeliveryError('TIMEOUT', `No response within ${Math.round(Math.min(REQUEST_TIMEOUT_MS, remaining) / 1000)}s`, 'unknown');
      } else if (code && CONNECT_ERRORS.includes(code)) {
        error = new DeliveryError('NETWORK', `Could not connect (${code})`);
      } else {
        error = new DeliveryError('NETWORK', 'Connection failed during the request', 'unknown');
      }
      if (error.outcome === 'unknown') {
        uncertain = true;
        if (!options.retryUnknown) throw fail(error);
      }
    }

    // Stop when out of attempts or when waiting would pass the deadline.
    if (attempts >= MAX_ATTEMPTS || Date.now() + wait >= deadline) throw fail(error);
    try {
      await sleep(wait, undefined, { signal });
    } catch {
      throw fail(error);
    }
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

// Read a small JSON success body for a provider ID; a malformed body is still a success.
export async function readId(response: Response, pick: (body: never) => unknown): Promise<string | undefined> {
  try {
    const id = pick(await response.json() as never);
    return id === undefined || id === null ? undefined : String(id);
  } catch {
    return undefined;
  }
}
