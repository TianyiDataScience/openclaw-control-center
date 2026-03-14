# Docker Deployment Guide

## Quick Start

### 1. Build and Run

```bash
# Development mode
docker-compose up -d

# Production mode (with stricter resource limits)
docker-compose -f docker-compose.prod.yml up -d
```

### 2. Access the Application

Open browser: http://localhost:4310

## Resource Optimization

### Default Configuration (Recommended for 512MB+ RAM)

- Memory limit: 256MB
- CPU limit: 0.5 cores
- Polling intervals: 10-30 seconds

### Production Configuration (For 256MB RAM or less)

Use `docker-compose.prod.yml`:
- Memory limit: 128MB
- CPU limit: 0.25 cores
- Polling intervals: 10-60 seconds
- Task heartbeat: Disabled

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| UI_MODE | true | Enable UI server |
| UI_PORT | 4310 | UI server port |
| GATEWAY_URL | ws://127.0.0.1:18789 | OpenClaw WebSocket |
| READONLY_MODE | true | Read-only mode |
| LOCAL_TOKEN_AUTH_REQUIRED | true | Require token |
| MONITOR_CONTINUOUS | false | Continuous monitoring |

## Common Commands

```bash
# View logs
docker-compose logs -f

# Stop
docker-compose down

# Rebuild
docker-compose build --no-cache

# Restart
docker-compose restart
```

## Troubleshooting

### Out of Memory

Use production config:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### High CPU Usage

Increase polling intervals in environment:
```bash
POLLING_INTERVALS_MS=sessionsList=60000,cron=120000 docker-compose up -d
```

### Health Check Failed

Check if port 4310 is available:
```bash
netstat -tulpn | grep 4310
```
