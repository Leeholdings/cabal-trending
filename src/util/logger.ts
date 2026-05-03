/**
 * Tiny structured logger. No deps, prints to stdout.
 */
import { getConfig } from '../config/loader.js';

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function levelEnabled(level: string): boolean {
  const cfg = LEVELS[getConfig().logLevel] ?? 20;
  return (LEVELS[level] ?? 20) >= cfg;
}

function ts(): string {
  return new Date().toISOString();
}

function fmt(level: string, msg: string, meta?: unknown): string {
  const m = meta ? ` ${JSON.stringify(meta)}` : '';
  return `${ts()} [${level.toUpperCase()}] ${msg}${m}`;
}

export const log = {
  debug: (msg: string, meta?: unknown) => levelEnabled('debug') && console.log(fmt('debug', msg, meta)),
  info:  (msg: string, meta?: unknown) => levelEnabled('info')  && console.log(fmt('info',  msg, meta)),
  warn:  (msg: string, meta?: unknown) => levelEnabled('warn')  && console.warn(fmt('warn',  msg, meta)),
  error: (msg: string, meta?: unknown) => levelEnabled('error') && console.error(fmt('error', msg, meta)),
};
