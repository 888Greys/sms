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
