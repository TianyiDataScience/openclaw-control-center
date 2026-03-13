# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
npm install
cp .env.example .env
npm run build
npm test
npm run smoke:ui
UI_MODE=true npm run dev
```

Then open `http://127.0.0.1:4310/?section=overview`.

## Common Commands

- `npm run dev` - Run the control center in development mode
- `npm run dev:continuous` - Run with continuous monitoring enabled
- `npm run dev:ui` - Run with UI server only
- `npm run build` - Compile TypeScript
- `npm test` - Run all tests
- `npm run smoke:ui` - Run UI smoke tests

### Running Single Tests

```bash
node --import tsx --test test/filename.test.ts
```

### Command-Line Commands

Set `APP_COMMAND` environment variable to run specific commands:

- `APP_COMMAND=backup-export npm run dev` - Export system snapshot
- `APP_COMMAND=import-validate COMMAND_ARG=<file.json> npm run dev` - Validate import file
- `APP_COMMAND=acks-prune npm run dev` - Prune stale acknowledgments
- `APP_COMMAND=task-heartbeat npm run dev` - Run task heartbeat check

### Validation Scripts

- `npm run validate:task-store` - Validate task store integrity
- `npm run validate:budget` - Validate budget configuration

## Architecture

This is a safety-first local control center for OpenClaw observability, task operations, and operator review.

### Key Layers

1. **Clients** (`src/clients/`) - Communicate with OpenClaw Gateway via WebSocket
   - `openclaw-live-client.ts` - Main client for live data from OpenClaw
   - `factory.ts` - Client factory

2. **Adapters** (`src/adapters/`) - Transform external data into internal models
   - `openclaw-readonly.ts` - Read-only adapter wrapping the client

3. **Runtime** (`src/runtime/`) - Core business logic
   - `commander.ts` - Main orchestrator for exception handling
   - `budget-governance.ts` - Budget monitoring and alerts
   - `task-store.ts` / `project-store.ts` - State management
   - `usage-cost.ts` - Token usage tracking
   - `notification-center.ts` - Alert/acknowledgment system

4. **UI** (`src/ui/server.ts`) - Express-based UI server on port 4310

### Data Flow

The system reads from OpenClaw Gateway (WebSocket) and produces:
- **ReadModelSnapshot** - Aggregated state (sessions, tasks, budgets, approvals)
- **CommanderExceptionsFeed** - Alert feed for blocked/error states
- **NotificationCenterSnapshot** - Acknowledged alerts

### Safety Features (Default Enabled)

- `READONLY_MODE=true` - No write operations by default
- `LOCAL_TOKEN_AUTH_REQUIRED=true` - Token required for protected commands
- `APPROVAL_ACTIONS_ENABLED=false` - Approval actions disabled by default
- All mutation commands default to dry-run mode

### Environment Variables

Key config in `src/config.ts`:
- `GATEWAY_URL` - OpenClaw WebSocket endpoint (default: `ws://127.0.0.1:18789`)
- `UI_PORT` - UI server port (default: 4310)
- `LOCAL_API_TOKEN` - Token for protected operations
- `READONLY_MODE`, `APPROVAL_ACTIONS_ENABLED`, `IMPORT_MUTATION_ENABLED` - Safety gates
