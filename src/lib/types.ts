export type Severity = 'info' | 'success' | 'warning' | 'error';

export interface Alert {
  title: string;
  message: string;
  severity?: Severity;
  context?: Record<string, string>;
}

/** An alert after validation; severity defaults to `info`. */
export type ValidAlert = Required<Pick<Alert, 'title' | 'message' | 'severity'>> & Pick<Alert, 'context'>;

/**
 * accepted: the provider accepted the request (not proof of receipt).
 * rejected: the provider (or a pre-send check) refused it.
 * unknown: the request may or may not have been processed, e.g. a timeout.
 * not_attempted: nothing was sent.
 */
export type Outcome = 'accepted' | 'rejected' | 'unknown' | 'not_attempted';

export type ErrorCode =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'RATE_LIMITED'
  | 'INVALID_PAYLOAD'
  | 'ABORTED'
  | 'UNKNOWN_DESTINATION'
  | 'PROVIDER_ERROR';

export interface DeliveryResult {
  destination: string;
  outcome: Outcome;
  attempts: number;
  durationMs: number;
  /** Provider message ID when the provider returns one. */
  providerId?: string;
  retryAfterMs?: number;
  error?: { code: ErrorCode; message: string };
}

export interface SendResult {
  /** Random ID for this send; webhooks receive it as `id`. */
  id: string;
  results: DeliveryResult[];
}

export interface ProviderOptions {
  signal?: AbortSignal;
  /** Absolute time (ms since epoch) after which no new attempt starts. */
  deadline: number;
  /** Caller key scoped to this destination; forwarded where supported. */
  idempotencyKey?: string;
  alertId: string;
}

export interface Receipt {
  id?: string;
  attempts?: number;
}

/** Implement this to add a provider. Throw DeliveryError for known failures. */
export interface Provider {
  send(alert: ValidAlert, options: ProviderOptions): Promise<Receipt | void>;
}

export class DeliveryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly outcome: Exclude<Outcome, 'accepted'> = 'rejected',
    readonly attempts = 1,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}
