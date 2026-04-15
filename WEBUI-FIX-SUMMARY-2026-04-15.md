# WebUI fix summary — 2026-04-15

## Problem
The OpenClaw Control Center web UI was timing out on `GET /` and failing `npm run smoke:ui`.

Observed behavior:
- UI smoke initially failed because the server did not become ready within 10 seconds.
- After startup sequencing was improved, the server listened successfully, but homepage rendering still timed out.
- `/healthz` reported `stale` during cold start because it depended on a monitor snapshot that could take tens of seconds to refresh.

## Root cause
The homepage render path was doing too much synchronous work during cold start:

1. **Startup ordering blocked UI availability**
   - `src/index.ts` awaited `runMonitorOnce(adapter)` before starting the UI server.
   - On a runtime with ~205 sessions, the first monitor pass could take ~25–30 seconds.

2. **Homepage render blocked on live runtime reads**
   - `readReadModelSnapshotWithLiveSessions()` could synchronously wait on live session loading.
   - `loadCachedSessionPreview()` synchronously built preview data from session histories.

3. **Homepage still had a hidden heavy path after the first fixes**
   - `buildGlobalVisibilityViewModel()` called `countRecentToolCalls()`.
   - That path ran `listSessionConversations()` again and scanned recent session histories for up to 20 sessions.
   - This duplicated expensive history work inside the first-page request.

4. **Cold-start health checks were too strict**
   - `/healthz` marked the app `stale` before the first background monitor pass finished.

## Fixes applied

### 1) Start UI before monitor
**File:** `src/index.ts`

Changed startup flow so that when `UI_MODE=true`:
- UI server starts immediately.
- Initial `runMonitorOnce(adapter)` runs in the background.

Result:
- Cold-start readiness is no longer blocked by a full monitor sweep.

### 2) Make live sessions non-blocking on first render
**File:** `src/ui/server.ts`

Added:
- `HTML_LIVE_SESSIONS_BLOCKING_TIMEOUT_MS = 250`

Changed behavior:
- `loadCachedLiveSessions()` now kicks off a background refresh and can return cached/empty fallback data immediately.
- `readReadModelSnapshotWithLiveSessions()` races live session loading against a short timeout and falls back to the snapshot if live data is not ready yet.

Result:
- Homepage does not block on slow live session queries.

### 3) Make session preview background-refreshable
**File:** `src/ui/server.ts`

Added:
- `renderSessionPreviewInFlight`

Changed behavior:
- `loadCachedSessionPreview()` no longer forces a synchronous rebuild on first request.
- It can return cached/empty fallback preview data while refreshing in the background.

Result:
- First-page render no longer waits on session-history preview construction.

### 4) Remove duplicate recent tool-call history scan from homepage critical path
**File:** `src/ui/server.ts`

Changed behavior:
- Homepage now derives `recentToolCallsCount` from already-available `taskSignalItems`.
- `buildGlobalVisibilityViewModel()` receives `toolCallsCount` directly instead of forcing another recent-session conversation scan.

Result:
- Removed the hidden duplicated history-read bottleneck that was still causing `GET /` timeouts.

### 5) Add startup grace period for healthz
**File:** `src/runtime/healthz.ts`

Added:
- `HEALTHZ_STARTUP_GRACE_MS = 60_000`

Changed behavior:
- During the first 60 seconds of process uptime, `stale` snapshot/monitor freshness is downgraded to `warn`.

Result:
- Cold-start `/healthz` now reports a warm-up state instead of a false hard failure.

### 6) Update brittle source-based test
**File:** `test/ui-render-smoke.test.ts`

Changed a hard-coded source assertion to match the new non-blocking live-session logic and assert the blocking-timeout constant.

Result:
- Tests validate the new behavior instead of the old synchronous implementation.

## Validation

### Manual validation
- Homepage request returned successfully:
  - `HTTP 200`
  - ~`0.227s` render time during verification

### Automated validation
- `npm test -- --test-reporter=spec`
  - **96/96 passing**
- `npm run smoke:ui`
  - **passed**

### Health validation
- Cold-start `/healthz` no longer hard-fails during initial warm-up.
- It now reports `warn` instead of `stale`/503 when background monitor work has not completed yet.

## Diff summary
Files changed:
- `src/index.ts`
- `src/runtime/healthz.ts`
- `src/ui/server.ts`
- `test/ui-render-smoke.test.ts`

Approximate diff:
- 121 insertions
- 35 deletions

## Suggested commit message
```text
fix(control-center): unblock web UI cold start and remove homepage render bottlenecks
```

## Suggested PR summary
This patch fixes Control Center WebUI timeouts by removing heavy synchronous work from the homepage critical path. The UI now starts before the first monitor sweep, live session and session preview reads degrade gracefully on cold start, duplicate recent tool-call history scans are removed from overview rendering, and `/healthz` now reports a startup warm-up state instead of a false stale failure.
