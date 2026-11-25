import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

import { redactText, redactValue } from './redaction';

export interface AppLogger {
  info(message: string, fields: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields: Readonly<Record<string, unknown>>): void;
  error(message: string, fields: Readonly<Record<string, unknown>>): void;
}

function sanitizeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redactValue(fields) as Record<string, unknown>;
}

function sanitizeMessage(message: string): string {
  return redactText(message);
}

export function createLogger(
  destination?: DestinationStream,
  level: string = process.env.LOG_LEVEL ?? 'info',
): AppLogger {
  const options: pino.LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        '*.token',
        '*.secret',
        '*.password',
        '*.authorization',
        '*.cookie',
        '*.code',
        '*.email',
        '*.signature',
      ],
      censor: '[REDACTED]',
    },
  };
  const writer: PinoLogger = destination ? pino(options, destination) : pino(options);
  const logger: AppLogger = {
    info(message: string, fields: Readonly<Record<string, unknown>>) {
      writer.info(sanitizeFields(fields), sanitizeMessage(message));
    },
    warn(message: string, fields: Readonly<Record<string, unknown>>) {
      writer.warn(sanitizeFields(fields), sanitizeMessage(message));
    },
    error(message: string, fields: Readonly<Record<string, unknown>>) {
      writer.error(sanitizeFields(fields), sanitizeMessage(message));
    },
  };
  return Object.freeze(logger);
}
