# Telegram Manual SMS Helper (Server + Upstash Redis)

This bot runs as a long-lived server process and uses Telegram long polling (`getUpdates`), with all state stored in Upstash Redis.

## Multi-Agent Behavior

- One agent can own only one batch at a time.
- One batch can be owned by only one agent at a time.
- Agents cannot pull numbers from batches they do not own.
- `/release` requeues current assigned number and unlocks the batch.
- Admins can unlock stuck ownership with `/force_release <batch>`.

## Agent Commands

- `/start`
- `/help`
- `/claim`
- `/claim <batch>`
- `/mybatch`
- `/next`
- `/progress`
- `/undo`
- `/release`
- `/status`

Admin-only:

- `/force_release <batch>`

## Prerequisites

- Node.js 20+
- Telegram bot token from `@BotFather`
- Upstash Redis database
- Server/VM where process can run continuously

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` and fill required values:

```bash
cp .env.example .env
```

3. Import local `sms_batches/*.txt` into Redis:

```bash
npm run import:batches
```

4. Build and start:

```bash
npm run build
npm start
```

On startup, the bot calls `deleteWebhook` and then starts polling.

## Environment Variables

Required:

- `BOT_TOKEN`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Optional:

- `REDIS_PREFIX` (default `smsbot`)
- `MIN_BATCH` (default `1`)
- `MAX_BATCH` (default `10`)
- `POLL_TIMEOUT_SECONDS` (default `50`)
- `POLL_RETRY_DELAY_MS` (default `2000`)
- `ADMIN_USER_IDS` (comma-separated Telegram user IDs)

## CI/Test

```bash
npm run check
npm test
```

`npm test` compiles TypeScript and runs Node's built-in test runner from `tests/`.
