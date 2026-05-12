const env = {
  UI_MODE: process.env.UI_MODE ?? "true",
  UI_PORT: process.env.UI_PORT ?? "4310",
  UI_TIMEZONE: process.env.UI_TIMEZONE ?? "Europe/Budapest",
  READONLY_MODE: process.env.READONLY_MODE ?? "true",
  LOCAL_TOKEN_AUTH_REQUIRED: process.env.LOCAL_TOKEN_AUTH_REQUIRED ?? "true",
  MONITOR_CONTINUOUS: process.env.MONITOR_CONTINUOUS ?? "true",
  GATEWAY_URL: process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789",
};

if (process.env.LOCAL_API_TOKEN) {
  env.LOCAL_API_TOKEN = process.env.LOCAL_API_TOKEN;
}

module.exports = {
  apps: [
    {
      name: "pandas-control-center",
      cwd: __dirname,
      script: "node",
      args: "--import tsx src/index.ts",
      env,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      out_file: "runtime/pm2-out.log",
      error_file: "runtime/pm2-error.log",
      time: true
    }
  ]
};
