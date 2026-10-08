import type { Channel } from './types';
import { fetchWithRetry } from './http';

function configuredUrls(): string[] {
  return (process.env.WEBHOOK_URLS ?? '').split(',').map(url => url.trim()).filter(Boolean);
}

export const webhookChannel: Channel = {
  name: 'webhook',
  isConfigured: () => configuredUrls().length > 0,
  async send(alert) {
    const urls = configuredUrls();
    if (!urls.length) throw new Error('No webhook URLs configured');
    const body = JSON.stringify(alert);

    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const res = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        await res.body?.cancel();
        if (!res.ok) throw new Error(`${url} → ${res.status}`);
      }),
    );

    const failed = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failed.length) throw new Error(failed.join('; '));
  },
};
