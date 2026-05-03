/**
 * Telegram sendMessage wrapper. Silent if not configured.
 */
import axios from 'axios';
import { getConfig } from '../config/loader.js';
import { log } from '../util/logger.js';

const TG_API = 'https://api.telegram.org';

export function isTelegramConfigured(): boolean {
  const t = getConfig().telegram;
  return Boolean(t.botToken && t.chatId);
}

export async function sendTelegramMessage(args: {
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}): Promise<boolean> {
  const t = getConfig().telegram;
  if (!isTelegramConfigured()) {
    log.debug('Telegram not configured — skipping send');
    return false;
  }
  try {
    const url = `${TG_API}/bot${t.botToken}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: t.chatId,
      text: args.text,
      parse_mode: args.parseMode ?? 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 15_000 });
    if (!res.data?.ok) {
      log.warn('Telegram returned non-ok', res.data);
      return false;
    }
    return true;
  } catch (err) {
    log.warn('Telegram send failed', { err: (err as Error).message });
    return false;
  }
}
