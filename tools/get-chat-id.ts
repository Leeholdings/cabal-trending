/**
 * One-shot helper. Run after creating bot + channel + posting any message
 * in the channel to find the channel's numeric chat_id.
 *
 * Usage:
 *   1. Create bot via @BotFather, copy token, add to .env as TELEGRAM_BOT_TOKEN
 *   2. Create a private Telegram channel
 *   3. Add your bot as admin (Post Messages = ON)
 *   4. Post any message in the channel
 *   5. npm run get-chat-id
 *   6. Copy the chat_id starting with -100 into TELEGRAM_CHAT_ID in .env
 */
import axios from 'axios';
import 'dotenv/config';

async function main(): Promise<void> {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env');
    process.exit(1);
  }
  const url = `https://api.telegram.org/bot${token}/getUpdates`;
  console.log(`Calling: ${url.slice(0, 50)}...`);
  const res = await axios.get(url, { timeout: 15_000 });
  const data = res.data as { ok: boolean; result: unknown[] };

  if (!data.ok) {
    console.error('ERROR from Telegram:', data);
    process.exit(2);
  }
  if (!data.result || data.result.length === 0) {
    console.error();
    console.error('No updates received yet. Make sure you have:');
    console.error('  1. Created a private Telegram channel');
    console.error('  2. Added your bot as admin (Post Messages = ON)');
    console.error('  3. Posted at least one message in the channel');
    console.error('  4. Wait 5 seconds, then re-run.');
    process.exit(3);
  }

  console.log(`\nFound ${data.result.length} update(s). Chat IDs detected:\n`);
  const seen = new Set<number>();
  for (const u of data.result as Record<string, unknown>[]) {
    const post = (u.channel_post ?? u.message) as { chat?: { id?: number; title?: string; type?: string } } | undefined;
    const chat = post?.chat;
    if (chat?.id && !seen.has(chat.id)) {
      seen.add(chat.id);
      console.log(`  chat_id = ${chat.id}   type=${chat.type ?? '?'}   title=${JSON.stringify(chat.title ?? '')}`);
    }
  }
  console.log();
  for (const id of seen) {
    if (String(id).startsWith('-100')) {
      console.log('Add this to .env:');
      console.log(`  TELEGRAM_CHAT_ID=${id}`);
      break;
    }
  }
}

main().catch((e) => {
  console.error('get-chat-id failed:', (e as Error).message);
  process.exit(1);
});
