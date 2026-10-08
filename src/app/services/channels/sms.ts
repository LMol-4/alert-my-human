import { renderText } from '@/app/services/alert';
import type { Channel } from './types';
import { fetchWithRetry, checkResponse } from './http';

export const smsChannel: Channel = {
  name: 'sms',
  isConfigured: () =>
    Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_FROM_NUMBER &&
        process.env.ALERT_PHONE_NUMBER,
    ),
  async send(alert) {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const body = new URLSearchParams({
      To: process.env.ALERT_PHONE_NUMBER!,
      From: process.env.TWILIO_FROM_NUMBER!,
      Body: renderText(alert),
    });
    const res = await fetchWithRetry(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    await checkResponse(res);
  },
};
