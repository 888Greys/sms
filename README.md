# Telegram Manual SMS Helper (Netlify + Upstash)

This bot serves one number at a time from your existing `sms_batches/*.txt` files and tracks actions (`Sent`, `Skip`, `Undo`) in Redis.

## What it does

- `/start`: choose a batch.
- `/batch` or `/batch <n>`: pick/change batch.
- `/next`: show current or next number.
- `/progress`: show totals.
- `/undo`: revert last `Sent` or `Skip`.

Inline buttons are attached to each number:

- `Sent ✅`
- `Skip ⏭`
- `Undo ↩`
- `Next ▶`

## Prerequisites

- Node.js 20+ (recommended)
- Telegram bot token from `@BotFather`
- Upstash Redis database
- Netlify site

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and fill values:

```bash
cp .env.example .env
```

3. Import your current batch files into Redis:

```bash
npm run import:batches
```

4. Deploy to Netlify.

5. Set Netlify environment variables:

- `BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `REDIS_PREFIX` (optional)

6. Set webhook (can be from local machine after deploy):

```bash
npm run set:webhook
```

`WEBHOOK_BASE_URL` must be your production site URL (for example `https://your-site.netlify.app`).

## Netlify endpoint

Webhook path:

`/.netlify/functions/telegram-webhook`

Health check:

`GET /.netlify/functions/telegram-webhook`

## Notes

- This is webhook-based (recommended for Netlify), not long polling.
- Number state is persistent in Redis; Netlify function filesystem is not used for progress.
- `Undo` restores the last action and places the number back at the front of that batch queue.
