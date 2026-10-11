import { randomUUID } from 'node:crypto';
import { validateAlert } from './render';
import { DeliveryError, type Alert, type DeliveryResult, type Provider, type SendResult, type ValidAlert } from './types';

export interface AlerterOptions {
  /** Named destinations, e.g. { phone: telegram({...}), team: slack({...}) }. */
  destinations: Record<string, Provider>;
  /** Total time per send, including retries. Default 25s. */
  deadlineMs?: number;
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
}

export function createAlerter({ destinations, deadlineMs = 25_000 }: AlerterOptions): Alerter {
  for (const [name, provider] of Object.entries(destinations ?? {})) {
    if (!name.trim() || typeof provider?.send !== 'function') throw new TypeError(`Destination "${name}" needs a name and a provider`);
  }

  async function deliver(destination: string, alert: ValidAlert, input: SendInput, alertId: string, deadline: number): Promise<DeliveryResult> {
    if (!Object.hasOwn(destinations, destination)) {
      return { destination, outcome: 'not_attempted', attempts: 0, durationMs: 0, error: { code: 'UNKNOWN_DESTINATION', message: 'Unknown destination' } };
    }
    const started = Date.now();
    try {
      const receipt = await destinations[destination].send(alert, {
        signal: input.signal,
        deadline,
        alertId,
        idempotencyKey: input.idempotencyKey && `${input.idempotencyKey}:${destination}`,
      });
      return {
        destination,
        outcome: 'accepted',
        attempts: receipt?.attempts ?? 1,
        durationMs: Date.now() - started,
        ...(receipt?.id && { providerId: receipt.id }),
      };
    } catch (error) {
      const known = error instanceof DeliveryError;
      return {
        destination,
        outcome: known ? error.outcome : 'unknown',
        attempts: known ? error.attempts : 1,
        durationMs: Date.now() - started,
        error: known ? { code: error.code, message: error.message } : { code: 'PROVIDER_ERROR', message: 'Provider threw an unexpected error' },
        ...(known && error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
      };
    }
  }

  return {
    destinations: Object.keys(destinations ?? {}),
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
