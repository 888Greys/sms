module.exports = {
  apps: [
    {
      name: "sms-bot",
      script: "dist/src/bot.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
