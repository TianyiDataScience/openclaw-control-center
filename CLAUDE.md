# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenClaw Control Center — a local operator dashboard for OpenClaw. It polls the OpenClaw Gateway, maintains local JSON stores, and serves a server-rendered UI on port 4310. Safety-first defaults: read-only mode, local token auth, mutations disabled.

## Commands

```bash
# Development
npm run dev:ui          # Start UI server (recommended)
npm run dev             # Single monitor pass, no UI
npm run dev:continuous  # Continuous monitoring loop
npm run build           # TypeScript compilation (tsc)

# Testing
npm test                # All tests (process-isolated runner)
npm run smoke:ui        # HTTP endpoint smoke test
npm run smoke:hall      # Hall collaboration smoke test
npm run validate        # Task store + budget integrity check

# Single test (process isolation — no jest/vitest, just spawn)
node --import tsx scripts/run-tests-isolated.ts test/some-file.test.ts
```

## Architecture

```
OpenClaw Gateway (ws://127.0.0.1:18789)
        ↓ polling
  src/clients/openclaw-live-client.ts    CLI wrapper: `openclaw sessions list --json` etc.
        ↓
  src/adapters/openclaw-readonly.ts      Caches statuses, detects state changes → ReadModelSnapshot
        ↓
  src/runtime/*                          50+ modules: stores, orchestrators, computations
        ↓
  src/ui/server.ts                       HTTP server: 30+ API routes + SSR HTML pages
        ↓
  Browser (SSE for live streaming)
```

**Entry point**: `src/index.ts` — routes CLI commands or starts UI server + monitor.

**Configuration**: `src/config.ts` — 45+ env vars. Key gates: `READONLY_MODE`, `HALL_RUNTIME_DISPATCH_ENABLED`, `LOCAL_TOKEN_AUTH_REQUIRED`.

**Types**: `src/types.ts` — all domain types. `src/contracts/openclaw-tools.ts` — Gateway protocol types.

## Hall (Collaboration) subsystem

The most complex subsystem. Agents collaborate in a group chat model with autonomous @mention routing.

| File | Role |
|------|------|
| `collaboration-hall-orchestrator.ts` | Central coordinator: message routing, dispatch, auto-chain, observer |
| `collaboration-hall-store.ts` | Persistence: 3 JSON files (halls, messages, task-cards) with write serialization |
| `hall-runtime-dispatch.ts` | Dispatches to real `openclaw agent` CLI, streams live output, builds prompts |
| `hall-mention-router.ts` | Resolves @mentions to participants (exact + prefix matching) |
| `hall-role-resolver.ts` | Maps agent names to semantic roles (manager, coder, reviewer, planner) |
| `collaboration-stream.ts` | SSE events: draft_start, draft_delta, draft_complete for live streaming |
| `collaboration-hall.ts` (ui) | Hall UI rendering (SSR + client-side JS in one file, ~3000 lines) |

**Dispatch flow**: `postHallMessage` → `scheduleRouteAndDispatch` (async) → `routeAndDispatchHallMessage` (determines targets: @mention → specific agent, no mention → main) → `dispatchHallAgentReply` → `dispatchHallRuntimeTurn` (calls `openclaw agent --agent <id> --message "..." --json`).

**Auto-chain**: When an agent @mentions another agent in its reply, the system auto-dispatches to the mentioned agent (up to depth 5).

**Observer**: After non-main agents respond, main is dispatched as background observer. If nothing to add, responds with `OBSERVE_SILENT` marker which gets suppressed.

## State files

All persisted under `runtime/` (or `OPENCLAW_RUNTIME_DIR` override):

- `collaboration-halls.json`, `collaboration-hall-messages.json`, `collaboration-task-cards.json` — Hall state
- `tasks.json`, `projects.json` — Task/project stores
- `operation-audit.log` — All mutation audit trail
- `last-snapshot.json` — Cached read model

## Key patterns

- **Agent dispatch uses the CLI** — `openclaw-live-client.ts` shells out to `openclaw agent` binary, not WebSocket. `agentRunStream` spawns a child process and reads stdout chunks.
- **Write serialization** — Hall store uses promise chains to prevent concurrent write corruption from parallel agent completions.
- **Test isolation** — `scripts/run-tests-isolated.ts` spawns each test file in a separate Node process. No shared state.
- **UI is SSR + hydration** — `server.ts` renders full HTML with embedded JSON bootstrap, client JS takes over for interactivity and SSE streaming.
- **All client JS is inline** — `renderCollaborationHallClientScript()` returns a `<script>` block with all hall interactivity. No bundler.
