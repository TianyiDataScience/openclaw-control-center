# OpenDashboard Deployment Notes

Date: 2026-04-13

## Preferred timezone

- Set `UI_TIMEZONE=America/New_York` for this deployment so dashboard absolute timestamps match the team's US Eastern working timezone.
- This affects rendered timestamps in the UI and makes ops review easier for the current team.

## Current topology

- `pm2` runs `openclaw-control-center`
- control center listens on `127.0.0.1:4310`
- `nginx` serves `opendashboard.ecomstack.net` on local port `80`
- `cloudflared` sends `opendashboard.ecomstack.net` to `http://localhost:80`
- existing local `3080` service is intentionally left untouched

Request flow:

```text
Browser
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> localhost:80 (nginx)
  -> 127.0.0.1:4310 (openclaw-control-center)
```

## Local runtime checks

```bash
pm2 list
pm2 logs openclaw-control-center --lines 50
systemctl --user status cloudflared-opendashboard.service
journalctl --user -u cloudflared-opendashboard.service -n 50 --no-pager
curl -H 'Host: opendashboard.ecomstack.net' 'http://127.0.0.1/?section=overview&lang=zh'
```

## Cloudflare Access symptom

If opening `https://opendashboard.ecomstack.net/` redirects to:

```text
https://openclaw.ecomstack.net/cdn-cgi/access/authorized?...
```

that usually means the Access configuration is coupling the two hostnames.

Most likely cause:

- `opendashboard.ecomstack.net` and `openclaw.ecomstack.net` are in the same self-hosted Access application
- Access is trying to pre-issue auth cookies across multiple domains in that single application
- the browser is redirected to `openclaw.ecomstack.net` during the authorization flow

## Recommended Access layout

Use separate Access applications:

1. One self-hosted app for `opendashboard.ecomstack.net`
2. One separate app for `openclaw.ecomstack.net`

Do not group them into one multi-domain Access application unless you explicitly want shared cross-domain login behavior.

## Cloudflare dashboard checklist

In Cloudflare Zero Trust:

1. Go to `Access -> Applications`
2. Find the application protecting `opendashboard.ecomstack.net`
3. Check whether `openclaw.ecomstack.net` is listed in the same application
4. If yes, remove `openclaw.ecomstack.net` from that app
5. Create or keep a dedicated self-hosted app only for `opendashboard.ecomstack.net`
6. Confirm the app has an `Allow` policy for your team
7. Test again in an incognito window

Suggested target state:

```text
Application A: OpenDashboard
  - opendashboard.ecomstack.net

Application B: OpenClaw
  - openclaw.ecomstack.net
```

## Tunnel config currently expected

`~/.cloudflared/config.yml`

```yaml
ingress:
  - hostname: opendashboard.ecomstack.net
    service: http://localhost:80
  - hostname: dashboard.ecomstack.net
    service: http://localhost:3080
  - service: http_status:404
```

## Nginx site currently expected

`deploy/opendashboard.ecomstack.net.nginx.conf`

```nginx
server {
    listen 80;
    server_name opendashboard.ecomstack.net;

    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

## PM2 persistence

```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u openclaw --hp /home/openclaw
su - openclaw -c 'pm2 save'
```
