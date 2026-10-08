import { Resend } from 'resend';
import { renderEmail } from '@/app/services/alert';
import type { Channel } from './types';
import { withTimeout } from './http';

// Initialize only when email is used; other channels need no Resend credentials.
let resend: Resend | undefined;

export const emailChannel: Channel = {
  name: 'email',
  isConfigured: () => Boolean(process.env.RESEND_API_KEY && process.env.SENDING_EMAIL && process.env.ALERT_EMAIL),
  async send(alert) {
    resend ??= new Resend(process.env.RESEND_API_KEY);
    const { subject, html, text } = renderEmail(alert);
    const to = process.env
      .ALERT_EMAIL!.split(',')
      .map((address) => address.trim())
      .filter(Boolean);

    const { error } = await withTimeout(
      resend.emails.send({
        from: `Alert <${process.env.SENDING_EMAIL}>`,
        to,
        subject,
        html,
        text,
      }),
    );
    if (error) throw new Error(error.message);
  },
};
