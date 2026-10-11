import { createAlerter, destinationsFromEnv, type DeliveryResult, type Severity } from '@/lib';

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function listChannels() {
  const { destinations, errors } = destinationsFromEnv();
  const channels = Object.keys(destinations);
  const lines = [
    channels.length
      ? `Configured channels: ${channels.join(', ')}.`
      : 'No channels are configured. Set the environment variables for at least one channel.',
    ...errors.map((error) => `Misconfigured: ${error}.`),
  ];
  return { content: text(lines.join('\n')), structuredContent: { channels, errors } };
}

function describe(result: DeliveryResult) {
  const details = [result.error && `${result.error.code}: ${result.error.message}`, result.reused && 'shared with an identical in-flight send']
    .filter(Boolean)
    .join('; ');
  return `${result.destination}${details ? ` (${details})` : ''}`;
}

const LABELS: Array<[DeliveryResult['outcome'], string]> = [
  ['accepted', 'Accepted'],
  ['rejected', 'Rejected'],
  ['unknown', 'Unknown outcome (may have been delivered)'],
  ['not_attempted', 'Not attempted'],
  ['suppressed', 'Suppressed'],
];

export async function sendAlert(input: {
  channels: string[];
  severity?: Severity;
  title: string;
  message: string;
  context?: Record<string, string>;
  idempotencyKey?: string;
}) {
  const { channels, ...alert } = input;
  // Built per call so environment changes and test overrides apply; no in-memory safeguards on serverless.
  const alerter = createAlerter({ destinations: destinationsFromEnv().destinations });
  let sent;
  try {
    sent = await alerter.send({ ...alert, destinations: channels });
  } catch (error) {
    return { content: text(`Invalid alert: ${(error as Error).message}`), isError: true };
  }

  const summary = LABELS.map(([outcome, label]) => {
    const matching = sent.results.filter((result) => result.outcome === outcome);
    return matching.length ? `${label}: ${matching.map(describe).join(', ')}.` : '';
  })
    .filter(Boolean)
    .join(' ');
  return {
    content: text(summary),
    structuredContent: { ...sent },
    // Partial success is not an error; callers should retry only failed destinations.
    isError: !sent.results.some((result) => result.outcome === 'accepted'),
  };
}
