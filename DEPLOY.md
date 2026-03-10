# Deploy on Render

Render runs this as a **Background Worker** (long-polling, no HTTP port needed).

## First-time setup

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New → Blueprint** and connect the repo.  
   Render will detect `render.yaml` automatically.
3. Fill in the secret env vars when prompted:
   - `BOT_TOKEN` — from @BotFather
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `ADMIN_USER_IDS` — comma-separated Telegram user IDs (optional)
   - `ALLOWED_USER_IDS` — comma-separated Telegram user IDs (optional; defaults to admins only)
4. Before or after the first deploy, run the batch import **once** from your local machine:
   ```bash
   # Make sure your local .env has the Upstash credentials
   npm run import:batches
   ```
   This loads `sms_batches/*.txt` into Upstash Redis. It only needs to be done once since data lives in Redis, not on Render's filesystem.
5. Deploy. The worker starts polling automatically.

## Updates

Push to your repo — Render will rebuild and restart the worker automatically.

## Logs

View live logs in the Render dashboard under your service → **Logs**.

---

# Server Deploy (PM2)

## First-time setup

```bash
git clone https://github.com/888Greys/sms.git
cd sms
npm install
cp .env.example .env
# edit .env
npm run import:batches
npm run build
npx pm2 start ecosystem.config.cjs --only sms-bot --env production
npx pm2 save
npx pm2 startup
```

## Update after new push

```bash
cd ~/sms
git pull
npm install
npm run build
npx pm2 restart sms-bot
```

## Useful commands

```bash
npx pm2 status
npx pm2 logs sms-bot
npx pm2 stop sms-bot
npx pm2 delete sms-bot
```
