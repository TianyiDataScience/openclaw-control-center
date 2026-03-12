# OpenClaw Control Center

<img src="docs/assets/overview-hero-en.png" alt="OpenClaw Control Center overview hero screenshot" width="1200" />

Safety-first local control center for OpenClaw.

Language: **English** | [中文](README.md)

## Why this exists
- One local place to see whether OpenClaw is healthy, busy, blocked, or drifting.
- Built for non-technical operators who need observability and certainty, not raw backend payloads.
- Safe first-run defaults:
  - read-only by default
  - local token auth by default
  - mutation routes disabled by default

## What you get
- `Overview`: health, current state, decisions waiting, and operator-facing summaries
- `Usage`: usage, spend, subscription windows, and connector status
- `Staff`: who is really working now versus only queued
- `Tasks`: current work, approvals, execution chains, and runtime evidence
- `Documents` and `Memory`: source-backed workbenches scoped to active OpenClaw agents

## Who it is for
- OpenClaw users who want one local control center for observability, usage, tasks, approvals, replay, documents, and memory
- teams running OpenClaw on one machine or a reachable local environment
- maintainers who want a public-ready, safety-first OpenClaw dashboard instead of a generic agent platform

## Screenshots
Example UI from a local OpenClaw environment:

<table>
  <tr>
    <td width="56%">
      <img src="docs/assets/token-share-en.png" alt="OpenClaw Control Center token attribution screenshot" width="100%" />
    </td>
    <td width="44%">
      <img src="docs/assets/staff-en.png" alt="OpenClaw Control Center staff page screenshot" width="100%" />
    </td>
  </tr>
  <tr>
    <td><strong>Token attribution</strong><br />See which timed jobs are actually consuming tokens and how the share splits across them.</td>
    <td><strong>Staff page</strong><br />See who is working now, who is on standby, recent output, and schedule state.</td>
  </tr>
</table>

## 5-minute start
```bash
npm install
cp .env.example .env
npm run build
npm test
npm run smoke:ui
UI_MODE=true npm run dev
```

Then open:
- `http://127.0.0.1:4310/?section=overview&lang=en`
- `http://127.0.0.1:4310/?section=overview&lang=zh`

## Section-by-section tour

### Overview
- The main operating screen for non-technical users.
- Shows the current control posture, key action items, runtime issues, stalled runs, budget risk, who is active, and what needs attention first.
- Best when you want one fast answer to: “Is OpenClaw okay right now?”

### Usage
- Shows today, 7-day, and 30-day usage and spend trends.
- Includes subscription windows, quota consumption, usage mix, and connector status.
- Best when you want to know whether spend or quota is becoming risky.

### Staff
- Shows who is truly active now versus who only has queued work.
- Separates live work from “next up” so backlog is not confused with active execution.
- Best when you want to know who is busy, idle, blocked, or waiting.

### Memory
- A source-backed workbench for daily and long-term memory files.
- Scoped to active OpenClaw agents from `openclaw.json`, so deleted agents do not keep showing up.
- Best when you want to inspect or edit memory that the current OpenClaw team is actually using.

### Documents
- A source-backed workbench for shared and agent-specific core markdown docs.
- Reads the real source files and writes back to the same files.
- Best when you want to maintain the actual working documents behind the system.

### Tasks
- Combines task board, schedule, approvals, execution chains, and runtime evidence.
- Helps distinguish mapped work from real execution evidence, and shows what is blocked or needs review.
- Best when you want to understand what is being carried, what is only planned, and what needs intervention.

### Settings
- Shows safety mode, connector status, and data-link expectations.
- Makes it clear what is connected, what is still partial, and which high-risk actions are intentionally disabled.
- Best when you want to verify environment setup or explain why a signal is missing.

For:
- Existing OpenClaw users who want a local control center for observability, usage, staff activity, tasks, approvals, replay, and documents.
- Teams running OpenClaw on the same machine or a reachable local environment.
- Not a generic dashboard for non-OpenClaw agent stacks.

## Core constraints
- Only touches files in `control-center/`.
- `READONLY_MODE=true` by default.
- `LOCAL_TOKEN_AUTH_REQUIRED=true` by default.
- `IMPORT_MUTATION_ENABLED=false` by default.
- `IMPORT_MUTATION_DRY_RUN=false` by default.
- Sensitive local read APIs can also require the local token when auth is enabled.
- Import/export and all state-changing endpoints require a local token when auth is enabled.
- Approval actions are hard-gated (`APPROVAL_ACTIONS_ENABLED=false` default).
- Approval actions are dry-run by default (`APPROVAL_ACTIONS_DRY_RUN=true`).
- Editable workspace roots are restricted to the main OpenClaw workspace by default; use `EDITABLE_WORKSPACE_ROOTS` to explicitly allow additional roots.
- No mutation of `~/.openclaw/openclaw.json`.

## Quick start
1. `npm install`
2. `cp .env.example .env`
3. Keep safe defaults for the first run; only change `GATEWAY_URL` or path overrides if your OpenClaw setup is non-standard.
4. `npm run build`
5. `npm test`
6. `npm run smoke:ui`
7. `UI_MODE=true npm run dev`

## Installation and onboarding

### 1. Before you start
You should already have:
- a working OpenClaw installation
- a reachable OpenClaw Gateway
- shell access with `node` and `npm`
- read access to your OpenClaw home directory

For the richest dashboard data, it also helps if this machine has:
- `~/.openclaw`
- `~/.codex`
- a readable OpenClaw subscription snapshot, if your setup stores one outside the default locations

### 2. Install the project
```bash
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd control-center
npm install
cp .env.example .env
```

If OpenClaw claims the repo is missing `src/runtime` or other core source files, do not start patching code. The canonical repo layout already includes:
- `package.json`
- `src/runtime`
- `src/ui`
- `.env.example`

That error usually means:
- the current directory is not the `openclaw-control-center` repo root
- the wrong repo was cloned
- the checkout/download is incomplete
- the agent is running in the wrong workspace

### 3. Recommended default: let your own OpenClaw do the install and setup
The best first-run path is not manual setup. The best path is to give your own OpenClaw one install instruction block and let it do the safe wiring for you.

If you want a copy-ready standalone file, use:
- [INSTALL_PROMPT.en.md](INSTALL_PROMPT.en.md)
- [INSTALL_PROMPT.md](INSTALL_PROMPT.md)

It should handle:
- environment checks
- dependency install
- `.env` creation or correction
- safe first-run defaults
- `build / test / smoke`
- a final summary of what to run and what to open

This install instruction already accounts for common real-world differences such as:
- no GPT / Codex subscription, or no readable subscription snapshot
- OpenClaw running on API keys or non-Codex providers (for example OpenAI API, Anthropic, OpenRouter, or another provider backend)
- non-default `~/.openclaw`, `~/.codex`, Gateway URL, or UI port
- more than one plausible OpenClaw home, more than one Gateway candidate, or a non-default workspace on the same machine
- a completely different active agent roster from the examples in this repo
- a machine that can build locally but is not yet connected to a live Gateway
- missing `node` / `npm`, no npm-registry connectivity, or insufficient write permissions in the repo
- missing optional data sources where the control center should still come up safely in read-only mode

Copy the full block below into OpenClaw:

```text
You are installing and connecting OpenClaw Control Center to this machine's OpenClaw environment.

Your goal is not to explain theory. Your goal is to complete a safe first-run setup end to end.

Hard rules:
1. Work only inside the control-center repository.
2. Do not modify application source code unless I explicitly ask.
3. Do not modify OpenClaw's own config files.
4. Do not enable live import or approval mutations.
5. Keep all high-risk write paths disabled.
6. Do not assume default agent names, default paths, or a default subscription model. Use real inspection results from this machine.
7. Do not treat missing subscription data, missing Codex data, or a missing billing snapshot as an install failure. If the UI can run safely, continue and clearly mark which panels will be degraded.
8. Do not fabricate, generate, or overwrite any provider API key, token, cookie, or external credential. If OpenClaw itself is missing those prerequisites, report the gap instead of guessing.

Follow this order:

Phase 1: inspect the environment
1. Check whether the OpenClaw Gateway is reachable and confirm the correct `GATEWAY_URL`.
2. Confirm the correct `OPENCLAW_HOME` and `CODEX_HOME` on this machine.
3. If the subscription or billing snapshot is stored outside the default path, find the correct `OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH`.
4. Confirm which prerequisites are truly present and which are missing-but-degradable. At minimum, evaluate:
   - `node`
   - `npm`
   - write access to the repo directory
   - npm-registry reachability if dependencies are not installed yet
   - the OpenClaw Gateway
   - `openclaw.json`
   - OpenClaw session/runtime data
   - `CODEX_HOME`
   - the subscription/billing snapshot
   - whether the provider/backend prerequisites used by OpenClaw are already present (check presence only; never print secrets)
5. If more than one plausible `OPENCLAW_HOME`, Gateway, or workspace exists, do not guess. Prefer the combination backed by a live Gateway, a readable `openclaw.json`, and the strongest evidence that it belongs to the current project. If it is still ambiguous, stop and list the candidates.
6. If a path, process, or file is missing in a way that makes the control center impossible to start at all, such as missing `node` / `npm`, no ability to download dependencies, a non-writable repo, or an unreadable OpenClaw root, stop and tell me exactly what is missing instead of guessing.
7. If the missing item only affects richer dashboards, such as subscription snapshots, Codex telemetry, part of the runtime data, or Codex-specific telemetry on a machine that actually uses API-key/provider mode, continue the install and mark those areas as "install can continue, but this surface will be partial".
8. Do not assume any fixed agent names. If `openclaw.json` is readable, treat it as the source of truth. If not, fall back to runtime-visible agents and explicitly say that roster confidence is lower.

Phase 2: install the project
9. Confirm that the current directory is the control-center repo root.
10. First verify the repo is complete. At minimum, confirm these paths exist:
   - `package.json`
   - `src/runtime`
   - `src/ui`
   - `.env.example`
11. If `src/runtime`, `src/ui`, or `package.json` is missing, do not continue and do not guess where the code should come from. Classify it as "wrong repo / incomplete checkout / wrong working directory", then:
   - leave the incorrect directory
   - re-clone `https://github.com/TianyiDataScience/openclaw-control-center.git`
   - continue only after entering the new repo root
12. Install dependencies.
13. If `.env` does not exist, create it from `.env.example`. If it already exists, update it while preserving safe first-run defaults. Do not delete unrelated user settings; only change the keys required for this connection.

Phase 3: apply safe first-run settings
14. Keep these values:
   - READONLY_MODE=true
   - LOCAL_TOKEN_AUTH_REQUIRED=true
   - APPROVAL_ACTIONS_ENABLED=false
   - APPROVAL_ACTIONS_DRY_RUN=true
   - IMPORT_MUTATION_ENABLED=false
   - IMPORT_MUTATION_DRY_RUN=false
   - UI_MODE=false
15. Only change these when the machine actually requires it:
   - GATEWAY_URL
   - OPENCLAW_HOME
   - CODEX_HOME
   - OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH
   - UI_PORT
16. If this machine runs OpenClaw on provider API keys or a non-Codex backend instead of a Codex / GPT subscription, do not treat that as an error. Continue the install as long as OpenClaw itself can run, and say clearly that subscription/quota surfaces may be partially visible or unavailable.
17. If `CODEX_HOME` does not exist, or this machine simply does not have Codex / GPT subscription data, do not invent a path. Leave it unset and say clearly that Usage / Subscription will be partially visible or unavailable.
18. If no subscription snapshot exists, do not fabricate `OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH`. Continue the install and say that quota/subscription cards will show disconnected or estimated states.
19. If `4310` is already in use, choose a free local port, write it to `UI_PORT`, and report the new address clearly.
20. Do not change application logic just because my agent roster differs from the examples in this repo. The control center should reflect the agents configured or visible on my own machine.

Phase 4: verify the install
21. Run:
   - npm run build
   - npm test
   - npm run smoke:ui
22. If any step fails, stop and tell me:
   - which step failed
   - why it failed
   - what I should do next
23. If build / test / smoke pass but the live Gateway is still unreachable, do not classify the install as failed. Classify it as "local UI ready, live observability not connected yet".
24. If OpenClaw itself cannot produce live data because external provider credentials are missing, do not call that a control-center install failure. Classify it separately as "control center installed, upstream OpenClaw prerequisite missing".

Phase 5: hand off a ready-to-run result
25. If verification passes, print:
   - which env values you changed
   - which env values stayed on the defaults
   - the exact command I should run next to launch the UI
   - the first 3 dashboard pages I should open
   - which missing signals are normal for a partially connected environment
   - which capabilities are working now
   - which capabilities are degraded because this machine lacks those data sources
   - which env values or prerequisites I would need later if I want to connect subscription / Codex / live Gateway data
   - which missing provider credentials, external auth, or upstream OpenClaw services are outside the control-center repo and still need operator action

Format your final answer as:
- Environment check
- Differences and degradation assessment
- Actual changes
- Verification result
- Next command
- First pages to open
```

### 4. If you want to configure `.env` manually
Only use this path if you do not want OpenClaw to handle setup for you.

For a safe first run, keep the mutation guards in place.

Use this baseline:
```dotenv
GATEWAY_URL=ws://127.0.0.1:18789
READONLY_MODE=true
APPROVAL_ACTIONS_ENABLED=false
APPROVAL_ACTIONS_DRY_RUN=true
IMPORT_MUTATION_ENABLED=false
IMPORT_MUTATION_DRY_RUN=false
LOCAL_TOKEN_AUTH_REQUIRED=true
UI_MODE=false
UI_PORT=4310

# Optional only when your paths differ from the defaults:
# OPENCLAW_HOME=/path/to/.openclaw
# CODEX_HOME=/path/to/.codex
# OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH=/path/to/subscription.json
```

Change only these values if your environment needs it:
- `GATEWAY_URL`: when your OpenClaw Gateway is not on the default local socket
- `OPENCLAW_HOME`: when OpenClaw is not stored in `~/.openclaw`
- `CODEX_HOME`: when Codex data is not stored in `~/.codex`
- `OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH`: when your billing/subscription snapshot lives somewhere custom
- `UI_PORT`: when `4310` is already in use

### 5. Verify the install
Run:
```bash
npm run build
npm test
npm run smoke:ui
```

Expected result:
- build passes
- tests pass
- UI smoke reports a local URL such as `http://127.0.0.1:<port>`

### 6. Start the UI
```bash
UI_MODE=true npm run dev
```

Then open:
- English UI: `http://127.0.0.1:4310/?section=overview&lang=en`
- Chinese UI: `http://127.0.0.1:4310/?section=overview&lang=zh`

If you changed `UI_PORT`, replace `4310` with your chosen port.

### 7. First-use checklist
On your first launch, check these pages in order:
1. `Overview`: the app opens and shows current system state.
2. `Usage`: usage and subscription panels either show real numbers or a clear missing-connector state.
3. `Staff`: live work status matches real active sessions.
4. `Tasks`: current work, approvals, and execution-chain cards load without raw payload noise.
5. `Documents` and `Memory`: the visible agent tabs match your active agents from `openclaw.json`.

### 8. If something looks wrong
- Empty live activity usually means `GATEWAY_URL` is wrong or the OpenClaw Gateway is not running.
- Missing `Documents / Memory` agents usually means `OPENCLAW_HOME` points to the wrong OpenClaw root or `openclaw.json` is missing.
- Missing usage/subscription data usually means `CODEX_HOME` or `OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH` needs to be set.
- If you only want a safe read-only dashboard, do not change the mutation defaults.

## Local commands
- `npm run build`
- `npm run dev`
- `npm run dev:continuous`
- `npm run dev:ui`
- `npm run smoke:ui`
- `npm run command:backup-export`
- `npm run command:import-validate -- runtime/exports/<file>.json`
- `npm run command:acks-prune`
- `npm test`
- `npm run validate`

For protected command modes (`command:backup-export`, `command:import-validate`, `command:acks-prune`), set `LOCAL_API_TOKEN=<token>` unless `LOCAL_TOKEN_AUTH_REQUIRED=false`.

## Maintainer publishing notes
If you are publishing the repository itself, not just installing it, use this section. Normal operators can skip it.

- Run `npm run release:audit` before public pushes
- See [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for the standalone repo release flow

## Local HTTP endpoints
- `GET /snapshot`: raw snapshot JSON
- `GET /projects`: list projects with optional query filters `status`, `owner`
- `GET /api/projects`: same as `/projects` for compatibility
- `POST /api/projects`: create project (`projectId`, `title`, optional `status`, `owner`)
- `PATCH /api/projects/:projectId`: update project title/status/owner
- `GET /tasks`: flattened task list with optional query filters `status`, `owner`, `project`
- `GET /api/tasks`: same as `/tasks` for compatibility
- `POST /api/tasks`: create task with schema validation
- `PATCH /api/tasks/:taskId/status`: update task status with schema validation
- `GET /sessions`: paginated session visibility list with optional filters `state`, `agentId`, `q`, and pagination params `page`, `pageSize`, `historyLimit`
- `GET /sessions/:id`: per-session JSON detail with latest history entries (`historyLimit` query supported)
- `GET /api/sessions/:id`: explicit API alias for per-session JSON detail
- `GET /session/:id`: localized session drill-down UI page (`lang=en|zh`) with latest messages, execution-chain evidence, and safe truncation
- `GET /api/sessions`: compatibility endpoint for `/sessions`
- `GET /api/commander/exceptions`: exceptions-only summary (blocked/errors/pending approvals/over-budget/tasks-due)
- `GET /exceptions`: routed exceptions feed with levels (`info`, `warn`, `action-required`), sorted by severity then newest event
- `GET /done-checklist`: final integration checklist + readiness scoring (`observability/governance/collaboration/security`)
- `GET /api/done-checklist`: API alias for done checklist
- `GET /api/action-queue`: notification center queue derived from exceptions feed + ack state + relevant session/task/project links
- `GET /api/action-queue/acks/prune-preview`: token-gated dry-run preview of stale ack prune counts (`before/removed/after`, no state mutation)
- `POST /api/action-queue/:itemId/ack`: acknowledge an action-required queue item (persisted), optional `ttlMinutes` or `snoozeUntil` to auto-expire ack state
- `GET /graph`: project-task-session linkage graph JSON (for future Gameboy view)
- `GET /view/pixel-state.json`: pixel-ready adapter state (`rooms`, `entities`, `links`) for future Gameboy canvas
- `GET /usage-cost`: product route alias that redirects to `/?section=usage-cost`
- `GET /api/usage-cost`: usage/billing observability snapshot (period totals, context windows, breakdowns, burn-rate, subscription consumed/remaining/cycle, connector TODOs)
- `GET /export/state.json`: bundled export with sessions/tasks/projects/budgets/exceptions + persisted debug snapshot + backup bundle in `runtime/exports/` (requires local token auth)
- `POST /api/import/dry-run`: dry-run validator for export bundles (`fileName` or inline `bundle`) with zero state mutation (requires local token auth)
- `POST /api/import/live`: optional live import mutation endpoint (high-risk, local-only); requires local token + `IMPORT_MUTATION_ENABLED=true`, blocked in readonly unless `dryRun=true`, and now returns validation errors instead of `500` for bad `fileName` paths
- `GET /notifications/preview`: notification policy preview with quiet-hours + severity routing
- `GET /cron`: cron overview with next run and health summary
- `GET /healthz`: system health payload (build info + snapshot freshness + monitor lag)
- `GET /digest/latest`: rendered HTML page from latest markdown digest file
- `GET /api/ui/preferences`: persisted dashboard UI preferences (`runtime/ui-preferences.json`)
- `PATCH /api/ui/preferences`: update dashboard UI preferences (`compactStatusStrip`, `quickFilter`, `taskFilters`)
- `GET /api/search/tasks`: safe substring search over tasks (`q`, `limit`), with `count` = total matches and `returned` = current response size
- `GET /api/search/projects`: safe substring search over projects (`q`, `limit`), with `count` = total matches and `returned` = current response size
- `GET /api/search/sessions`: safe substring search over sessions (`q`, `limit`), with `count` = total matches, `returned` = current response size, and live-session merge parity with `/sessions`
- `GET /api/search/exceptions`: safe substring search over exception feed (`q`, `limit`), with `count` = total matches and `returned` = current response size
- `GET /api/replay/index`: replay/debug index from timeline + digests + export snapshots + export bundles, optional `from`/`to` ISO time window filters, plus per-source `stats` (`total`, `returned`, `filteredOut`, window-vs-limit breakdown, `latencyMs`, `latencyBucketsMs` with `p50/p95`, `totalSizeBytes`, `returnedSizeBytes`)
- `GET /api/docs`: route + schema summary endpoint
- `GET /docs`: localized docs index page (read-only) with direct return path to the `Documents` section
- `GET /docs/readme|runbook|architecture|progress`: local markdown docs views (read-only, `lang` accepted for index/back-link flow)
- `POST /api/approvals/:approvalId/approve`: approval action service (gate + dry-run + audit)
- `POST /api/approvals/:approvalId/reject`: rejection action service (gate + dry-run + audit)
- `GET /audit`: local audit timeline page (newest-first, severity filter)
- `GET /api/audit`: audit timeline JSON (`severity=all|info|warn|action-required|error`)

## Dashboard highlights (Phase 14)
- Home page includes inline scoped search UI wired to `/api/search/*`.
- Home page replay/export visibility card now shows returned/filtered counts and latency/size indicators from `/api/replay/index`.
- Guard table shows explicit disabled/enabled badges and linked local docs references.

## Dashboard highlights (Phase 107, Approvals/replay/tool-activity correctness sweep)
- Approval counts now use the full live approval set:
  - sidebar and task-hub decision counts no longer under-report when approval previews are truncated
  - approval preview lists stay short but now make it explicit when only the latest subset is shown
- Replay visibility chips now show total available history:
  - timeline events
  - daily digests
  - export snapshots
  - backup bundles
- Overview tool activity detail now loads actual session evidence:
  - it no longer claims there are no tool-call sessions while the same page shows active tool-call counts
- User-facing parity routes no longer advertise deprecated dashboard sections:
  - approvals route points to the task hub decision lane
  - replay route points to `/audit`

## Dashboard highlights (Phase 110, Docs/memory active-agent scope alignment)
- `Documents` and `Memory` now follow active OpenClaw agent config instead of stale workspace folders:
  - facets are resolved from `~/.openclaw/openclaw.json` first
  - removed agents no longer appear just because an old folder still exists under `workspace/agents/`
  - root OpenClaw files are now shown as `Main` instead of `共享`
- Editable file content remains source-of-truth current:
  - file lists still read live filesystem metadata (`updatedAt`, size, path)
  - opening a file reads the current source file
  - saving a file writes directly back to that same source file

## Dashboard highlights (Phase 111, Execution-chain readability cleanup)
- `Execution chain` cards no longer surface raw JSON payloads as the visible headline or summary.
- Unmapped isolated-run cards now use stable labels such as `Main · Cron 隔离执行`.
- JSON-like payloads are summarized into short readable lines:
  - `成功 · 查询 30 · 成功 30`
  - `失败 · 错误 locked`
  - `成功 · 扫描 120 · 入选 2 · 发送 2`
- Long titles and session keys now wrap/clamp inside the card instead of pushing badges out of place.

## Dashboard highlights (Phase 112, Staff status freshness semantics)
- Staff `Working / 工作中` now means live execution, not just “still owns unfinished tasks”.
- Agents with backlog but no live session now stay in standby semantics instead of looking falsely active.
- Staff work labels now separate:
  - live work: `Working on / 正在处理什么`
  - queued next task: `Next up / 下一项`
- Staff/recent-activity cache remains short-lived at about `3s`; live-session polling baseline remains `5s`.

## Dashboard highlights (Phase 114, Execution-chain card hardening)
- Execution-chain cards no longer allow raw JSON-like payloads to become visible titles.
- Structured payload-shaped titles are converted into short human summaries or stable fallback labels instead.
- Long titles, meta rows, and badge rails are now overflow-safe inside the card grid.

## Dashboard highlights (Phase 115, Apple-native card elevation tune)
- Page canvas is slightly cooler and quieter so foreground cards stand out more cleanly.
- Core cards now use brighter layered fills, crisper borders, and deeper but still restrained elevation.
- The hierarchy is unchanged; this is a visual polish pass, not a layout rewrite.

## Dashboard highlights (Phase 116, Config-truthful document and memory scopes)
- `Documents / Memory` no longer revive deleted agents just because stale folders still remain on disk.
- Valid active-agent config remains the only truth source for those facet buttons.
- If config becomes unreadable, the workbench now falls back conservatively to `Main` only instead of showing stale agent folders.

## Dashboard highlights (Phase 106, Cold-path cache coalescing)
- Correctness stays unified across Overview / Settings / Usage:
  - no return to split summary/full quota logic
  - repeat navigations keep the same usage/quota truth when the underlying execution state is unchanged
- Heavy evidence scans are now reused instead of recomputed per page:
  - runtime usage logs
  - Codex subscription/quota telemetry
  - digest history
  - OpenClaw cron name catalog
- UI startup now primes dashboard caches, and concurrent page opens share the same heavy build work.
- In local smoke:
  - back-to-back `Overview` renders dropped to about `0.41s`
  - back-to-back `Usage` renders dropped to about `0.41s`
  - after one priming hit, concurrent `Overview / Settings / Usage` completed in about `1.13s`

## Dashboard highlights (Phase 105, Observability correctness alignment)
- Overview / Tasks / Settings / Usage now share one usage/quota truth source:
  - the same today-usage number
  - the same Codex quota windows
  - the same subscription-status judgement
- Active-session counts are aligned across:
  - overview KPI
  - certainty card
  - sidebar / summary strips
- Task certainty no longer depends on only the first recent-session page:
  - linked session evidence is loaded for the visible task set
  - task detail pages no longer stop at the first 6 linked sessions
- Detail links now keep the current UI language when opening task / cron drill-down pages.

## Dashboard highlights (Phase 15, UX v2)
- Home dashboard is now organized into six operator tabs with persistent left navigation:
  - `Overview`
  - `Office Space`
  - `Projects/Tasks`
  - `Alerts`
  - `Replay/Audit`
  - `Settings`
- UI moved to a colorful pixel-arcade visual style with dual sidebars (navigation + context rail).
- New `Office Space` view shows who is busy on what, grouped by office zones.
- Agent cards now include automatic animal identities derived from agent name semantics, with deterministic fallback mapping.
- Empty/zero-heavy blocks are softened:
  - non-actionable zero states are minimized
  - user-facing empty states now say `Not activated yet`.
- Home copy was rewritten from debug-heavy wording to operator-focused language while preserving all existing routes and backend behavior.

## Dashboard highlights (Phase 22, Usage/Cost parity surfaces)
- Added `Usage & Cost` section in the primary sidebar IA.
- Added Overview card-level usage/cost pulse:
  - period totals (`today`, `7d`, `30d`)
  - request-count source state
  - burn-rate headline
- Added dedicated Usage & Cost dashboard section:
  - context window visibility per active session/agent (absolute tokens + % when context catalog is available)
  - pace/trend labels + warning thresholds
  - usage/cost breakdown by agent, project, model, provider
  - budget burn-rate status and alert messaging
- Added graceful unavailable-state behavior:
  - explicit `Data source not connected` labels for disconnected metrics (instead of fake zeros)
  - connector TODO list surfaced in Settings
- Added usage adapter endpoint:
  - `GET /api/usage-cost`

## Dashboard highlights (Phase 25, Mission Control v3)
- UI visual reset to polished pixel-office style:
  - design-token based palette/spacing/radius/shadow system
  - layered office background grid + glow depth
  - responsive desktop/mobile hierarchy with subtle card/status motion
- Navigation and copy reset for operator clarity:
  - `Command Deck`, `Usage & Billing`, `Pixel Office`, `Work Board`, `Decisions`, `Timeline`, `Control Room`
  - reduced technical wording on primary surfaces
  - advanced links preserved under explicit disclosure
- Mac parity surfaces panel added with status + route entry for:
  - conversations, approvals/decision queue, cron, projects/tasks, usage/cost, replay/audit, health/digest, export/import dry-run safety, pixel adapter
- Full roster office model:
  - best-effort OpenClaw roster read from `~/.openclaw/openclaw.json` via `src/runtime/agent-roster.ts`
  - office floor now renders desk/zone occupancy and includes known agents beyond active sessions
- Subscription usage/remaining best-effort integration:
  - adapter support in `src/runtime/usage-cost.ts` for connected/partial/not_connected states
  - UI now shows consumed/remaining/limit/cycle/source and explicit connection targets when unavailable

## Dashboard highlights (Phase 68, Plain-language certainty)
- Added `Information certainty` card to Overview and Settings:
  - tells non-technical operators which parts of the picture are trustworthy now
  - calls out remaining blind spots in plain language
- Added `Execution certainty` board to Tasks:
  - scores whether each in-flight task is backed by real execution evidence
  - separates `evidence is strong` from `needs follow-up` and `evidence is weak`
- Task detail pages now act as evidence pages:
  - certainty judgement
  - linked session evidence and recent activity summaries

## API validation/error envelope
- API mutating routes require `Content-Type: application/json`.
- Import/export and mutating routes require local token auth by default:
  - header: `x-local-token: <LOCAL_API_TOKEN>`
  - or `Authorization: Bearer <LOCAL_API_TOKEN>`
- Strict API query validation rejects unknown query keys.
- JSON errors use a consistent envelope:
  - `{"ok":false,"requestId":"...","error":{"code":"...","status":<http>,"message":"...","issues":[],"requestId":"..."}}`
- JSON responses include `requestId` and all responses include `x-request-id` header for correlation.

## Live import warning
- `POST /api/import/live` is intentionally disabled by default.
- Do not enable it unless you are doing a controlled local restore test.
- Live mode mutates local runtime stores (`runtime/projects.json`, `runtime/tasks.json`, `runtime/budgets.json`).
- Keep `READONLY_MODE=true` and `IMPORT_MUTATION_ENABLED=false` in normal operation.

## Runtime files
- `runtime/last-snapshot.json`
- `runtime/timeline.log`
- `runtime/projects.json`
- `runtime/tasks.json`
- `runtime/budgets.json`
- `runtime/notification-policy.json`
- `runtime/model-context-catalog.json`
- `runtime/ui-preferences.json`
- `runtime/acks.json`
- `runtime/approval-actions.log`
- `runtime/operation-audit.log`
- `runtime/digests/YYYY-MM-DD.json`
- `runtime/digests/YYYY-MM-DD.md`
- `runtime/export-snapshots/*.json`
- `runtime/exports/*.json`

## Docs
- `docs/ARCHITECTURE.md`
- `docs/RUNBOOK.md`
- `docs/PROGRESS.md`
