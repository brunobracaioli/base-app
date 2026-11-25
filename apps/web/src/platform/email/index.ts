import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
} from 'resend';

import type { EmailMessage, EmailSender } from '../extensions/ports';

export interface ResendEmailClient {
  readonly emails: {
    send(
      payload: CreateEmailOptions,
      requestOptions: CreateEmailRequestOptions,
    ): Promise<CreateEmailResponse>;
  };
}

export class EmailProviderError extends Error {
  readonly code = 'email.provider_unavailable';

  constructor() {
    super('Email provider is unavailable.');
    this.name = 'EmailProviderError';
  }
}

export function createResendEmailSender(
  client: ResendEmailClient,
  from: string,
  timeoutMs = 5_000,
): EmailSender {
  return {
    async send(message: EmailMessage): Promise<void> {
      const payload: CreateEmailOptions = {
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      };
      let result: CreateEmailResponse;
      try {
        result = await client.emails.send(payload, {
          idempotencyKey: message.idempotencyKey,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new EmailProviderError();
      }
      if (result.error) throw new EmailProviderError();
    },
  };
}

export function createConfiguredResendEmailSender(input: {
  readonly apiKey: string | undefined;
  readonly from: string | undefined;
  readonly timeoutMs?: number;
}): EmailSender {
  if (!input.apiKey || !input.from) {
    return {
      async send(): Promise<void> {
        throw new EmailProviderError();
      },
    };
  }
  const client = new Resend(input.apiKey);
  return createResendEmailSender(client, input.from, input.timeoutMs);
}
