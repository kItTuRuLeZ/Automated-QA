import pino from 'pino';
import { sanitizeText } from './redaction.js';

/**
 * Structured JSON logger. Header/cookie fields are removed and every string
 * message passes through URL sanitization before it is written.
 */
export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.CQA_LOG_LEVEL ?? 'info',
    redact: {
      paths: ['*.headers.authorization', '*.headers.cookie', '*.headers["set-cookie"]', 'authorization', 'cookie', '*.password', '*.token', '*.apiKey'],
      censor: '[REDACTED]',
    },
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((a) => (typeof a === 'string' ? sanitizeText(a) : a)) as Parameters<typeof method>;
        method.apply(this, cleaned);
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
