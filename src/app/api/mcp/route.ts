import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';
import { isAuthorized } from '@/app/services/auth';
import { listChannels, sendAlert } from '@/app/services/tools';
import { LIMITS } from '@/lib';

// Sends stop starting attempts after a 25s deadline; leave room for handler overhead.
export const maxDuration = 30;

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'list_channels',
      {
        title: 'List Channels',
        description: 'List which alert channels are currently configured. Call this before send_alert to know which channel names are valid.',
        inputSchema: z.object({}),
      },
      async () => listChannels(),
    );

    server.registerTool(
      'send_alert',
      {
        title: 'Send Alert',
        description:
          'Send an alert to specific channels. Use this to notify a human when something needs their attention (a job failed, data is missing, a task succeeded, etc). Call list_channels first to see which channel names are configured. Each channel reports accepted, rejected, unknown (may have been delivered), not_attempted, or suppressed; retry only channels that did not accept.',
        inputSchema: z.object({
          channels: z
            .array(z.string())
            .min(1)
            .describe('Channel names to deliver to (e.g. "slack", "email"). Call list_channels to see what is configured.'),
          severity: z.enum(['info', 'success', 'warning', 'error']).default('info'),
          title: z.string().trim().min(1).max(LIMITS.title).describe('Short headline for the alert.'),
          message: z.string().trim().min(1).max(LIMITS.message).describe('The body of the alert.'),
          context: z
            .record(z.string().min(1).max(LIMITS.contextKey), z.string().max(LIMITS.contextValue))
            .refine((context) => Object.keys(context).length <= LIMITS.contextEntries, `At most ${LIMITS.contextEntries} entries`)
            .optional()
            .describe('Optional key/value details shown alongside the message (e.g. job name, error code).'),
          idempotencyKey: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe('Optional. Reuse the same key when retrying this alert; supported by email and sent to webhooks.'),
        }),
      },
      async (input) => sendAlert(input),
    );
  },
  {},
  { basePath: '/api' },
);

async function handler(request: Request) {
  if (!isAuthorized(request)) {
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
  }
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
