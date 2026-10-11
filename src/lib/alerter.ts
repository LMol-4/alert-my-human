import { createHash, randomUUID } from 'node:crypto';
import { validateAlert } from './render';
import { DeliveryError, type Alert, type DeliveryResult, type Provider, type SendResult, type ValidAlert } from './types';

export interface AlerterOptions {
  /** Named destinations, e.g. { phone: telegram({...}), team: slack({...}) }. */
  destinations: Record<string, Provider>;
  /** Total time per send, including retries. Default 25s. */
  deadlineMs?: number;
  /** Called with each result; exceptions it throws are ignored. */
  onResult?: (result: DeliveryResult) => void;

  // Optional in-memory safeguards. State lives only in this alerter instance:
  // it resets on restart and is not shared across processes or serverless instances.

  /** Share identical concurrent sends and suppress repeats of an accepted alert within ttlMs. */
  dedupe?: { ttlMs: number; maxEntries?: number };
  /** At most `limit` attempted sends per destination per fixed window. */
  rateLimit?: { limit: number; windowMs: number };
  /** Bound simultaneous provider sends; extra sends wait in a queue of maxQueued (default 100). */
  concurrency?: { max: number; maxQueued?: number };
  /** Keep metadata (never alert bodies) for this many recent results; see recent(). */
  history?: number;
}

export interface SendInput extends Alert {
  destinations: string[];
  /** Forwarded per destination as `<key>:<destination>` to providers that support it. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface Alerter {
  readonly destinations: string[];
  send(input: SendInput): Promise<SendResult>;
  recent(): DeliveryResult[];
}

type Entry = { pending?: Promise<DeliveryResult>; expires: number };

export function createAlerter(options: AlerterOptions): Alerter {
  const { destinations, deadlineMs = 25_000, onResult, dedupe, rateLimit, concurrency, history = 0 } = options;
  for (const [name, provider] of Object.entries(destinations ?? {})) {
    if (!name.trim() || typeof provider?.send !== 'function') throw new TypeError(`Destination "${name}" needs a name and a provider`);
  }
  const names = Object.keys(destinations ?? {});
  const seen = new Map<string, Entry>();
  const cap = dedupe?.maxEntries ?? 1000;
  const windows = new Map<string, { start: number; count: number }>();
  const recentResults: DeliveryResult[] = [];
  let active = 0;
  const queue: Array<() => void> = [];

  const finish = (result: DeliveryResult) => {
    if (history > 0) {
      recentResults.push(result);
      if (recentResults.length > history) recentResults.shift();
    }
    try {
      onResult?.(result);
    } catch {
      // A logging failure must not change a delivery outcome.
    }
    return result;
  };

  const skipped = (destination: string, outcome: 'not_attempted' | 'suppressed', code: DeliveryError['code'], message: string, retryAfterMs?: number) =>
    finish({ destination, outcome, attempts: 0, durationMs: 0, error: { code, message }, ...(retryAfterMs !== undefined && { retryAfterMs }) });

  async function attempt(destination: string, alert: ValidAlert, input: SendInput, alertId: string, deadline: number): Promise<DeliveryResult> {
    const started = Date.now();
    if (concurrency) {
      if (active >= concurrency.max) {
        if (queue.length >= (concurrency.maxQueued ?? 100)) {
          return skipped(destination, 'not_attempted', 'OVERLOADED', 'Too many sends are already queued');
        }
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        active++;
      }
    }
    try {
      const receipt = await destinations[destination].send(alert, {
        signal: input.signal,
        deadline,
        alertId,
        idempotencyKey: input.idempotencyKey && `${input.idempotencyKey}:${destination}`,
      });
      return finish({
        destination,
        outcome: 'accepted',
        attempts: receipt?.attempts ?? 1,
        durationMs: Date.now() - started,
        ...(receipt?.id && { providerId: receipt.id }),
      });
    } catch (error) {
      const known = error instanceof DeliveryError;
      return finish({
        destination,
        outcome: known ? error.outcome : 'unknown',
        attempts: known ? error.attempts : 1,
        durationMs: Date.now() - started,
        error: known ? { code: error.code, message: error.message } : { code: 'PROVIDER_ERROR', message: 'Provider threw an unexpected error' },
        ...(known && error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
      });
    } finally {
      if (concurrency) {
        // Hand the slot straight to the next queued send.
        const next = queue.shift();
        if (next) next();
        else active--;
      }
    }
  }

  async function deliver(destination: string, alert: ValidAlert, input: SendInput, alertId: string, deadline: number) {
    if (!Object.hasOwn(destinations, destination)) {
      return skipped(destination, 'not_attempted', 'UNKNOWN_DESTINATION', 'Unknown destination');
    }

    // Hash the alert so duplicate tracking never retains message bodies.
    const key = dedupe && `${destination}\0${createHash('sha256').update(JSON.stringify(alert)).digest('base64url')}`;
    if (key) {
      const now = Date.now();
      const entry = seen.get(key);
      if (entry?.pending) return finish({ ...(await entry.pending), reused: 'in-flight' });
      if (entry && entry.expires > now) {
        return skipped(destination, 'suppressed', 'DUPLICATE', 'Identical alert accepted recently', entry.expires - now);
      }
      seen.delete(key);
      if (seen.size >= cap) {
        // Evict expired entries, then the oldest finished one; never evict in-flight sends.
        for (const [k, e] of seen) if (!e.pending && e.expires <= now) seen.delete(k);
        for (const [k, e] of seen) {
          if (seen.size < cap) break;
          if (!e.pending) seen.delete(k);
        }
        if (seen.size >= cap) {
          return skipped(destination, 'not_attempted', 'OVERLOADED', 'Too many identical-alert checks are in flight');
        }
      }
    }

    if (rateLimit) {
      const now = Date.now();
      let window = windows.get(destination);
      if (!window || now - window.start >= rateLimit.windowMs) windows.set(destination, (window = { start: now, count: 0 }));
      if (window.count >= rateLimit.limit) {
        return skipped(destination, 'suppressed', 'LOCAL_RATE_LIMIT', 'Local rate limit reached', window.start + rateLimit.windowMs - now);
      }
      window.count++;
    }

    if (!key) return attempt(destination, alert, input, alertId, deadline);
    const pending = attempt(destination, alert, input, alertId, deadline);
    seen.set(key, { pending, expires: Infinity });
    const result = await pending;
    // Only accepted sends are remembered; rejected or unknown outcomes may be retried.
    if (result.outcome === 'accepted') seen.set(key, { expires: Date.now() + dedupe!.ttlMs });
    else seen.delete(key);
    return result;
  }

  return {
    destinations: names,
    recent: () => [...recentResults],
    async send(input) {
      const alert = validateAlert(input);
      if (!Array.isArray(input.destinations) || !input.destinations.length) throw new TypeError('destinations must list at least one name');
      const requested = [...new Set(input.destinations)];
      const id = randomUUID();
      const deadline = Date.now() + deadlineMs;
      const results = await Promise.all(requested.map((name) => deliver(name, alert, input, id, deadline)));
      return { id, results };
    },
  };
}
