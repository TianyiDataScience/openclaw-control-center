# Windows Local Skill Platform Task Breakdown

## Phase 0: Prototype And Validation

Goal: confirm the product flow before wiring runtime code.

- Create a single-page HTML prototype for the Windows local skill platform.
- Validate the v1 navigation: Doctor, Skill Library, New Task, Approvals, Results, Settings.
- Confirm the default task flow: select skill, authorize workspace, run prompt, review output.
- Capture feedback and update the PRD before implementation.

Acceptance:
- Prototype can be opened locally in a browser.
- The user can identify the intended v1 flow without extra explanation.
- Missing or confusing sections are listed before engineering starts.

## Phase 1: Windows Desktop Shell

Goal: create the installable Windows app wrapper.

- Choose Electron as the v1 shell for speed and Node compatibility.
- Create app shell with local backend process, renderer UI, tray entry, and app data directory.
- Add Windows installer packaging and Start Menu shortcut.
- Add first-run launch behavior.

Acceptance:
- App installs and opens on Windows 11.
- App data lives under `%LOCALAPPDATA%`.
- The shell can open a local file/folder picker and pass the path to the backend.

## Phase 2: First-Run Doctor

Goal: make setup visible and fixable.

- Detect OpenClaw home, config readability, workspace root, skill roots, Node runtime, local port availability, and PowerShell constraints.
- Show pass/warn/fail states with concrete fixes.
- Persist resolved paths and safety defaults.

Acceptance:
- Clean Windows machine shows a useful setup checklist.
- Existing OpenClaw install is detected without manual path entry.
- Path failures with spaces or Chinese characters are handled correctly.

## Phase 3: Skill Indexer

Goal: discover local OpenClaw-compatible skills without running them.

- Scan configured roots: `~/.openclaw/skills`, `~/.codex/skills`, `~/.agents/skills`, and user-added folders.
- Parse `SKILL.md` metadata safely.
- Deduplicate by skill name and source priority.
- Persist a local skill index.

Acceptance:
- 200 local skills scan in under 5 seconds on a normal SSD.
- Broken or incomplete skills show warnings instead of crashing the app.
- Skill indexing does not execute skill code.

## Phase 4: Task Runner And OpenClaw Adapter

Goal: run one selected skill through OpenClaw.

- Create task API with prompt, skill id, model option, and authorized workspace.
- Build OpenClaw adapter that sends execution requests and normalizes runtime events.
- Track task states: queued, running, waiting for approval, completed, failed, cancelled.
- Stream task timeline events to the UI.

Acceptance:
- A selected skill can run against an authorized folder.
- Task status updates live.
- Failed tasks show cause and next step.

## Phase 5: Safety And Approval Layer

Goal: keep local execution trustworthy.

- Enforce folder authorization.
- Require confirmation for delete, package install, system config changes, unknown network calls, and writes outside the workspace.
- Store secrets using Windows Credential Manager or encrypted OS-backed storage.
- Write audit events for starts, approvals, denials, outputs, and errors.

Acceptance:
- Risky operations pause the task and wait for user approval.
- Denied operations are logged and visible in task evidence.
- API keys are masked everywhere outside secure storage.

## Phase 6: Results And Evidence

Goal: make task output easy to inspect and replay.

- Show generated files, modified files, final summary, and key logs.
- Save prompt, skill id, workspace, approvals, timestamps, and outputs.
- Export evidence as JSON plus Markdown.

Acceptance:
- Every finished task has a readable evidence view.
- Evidence export excludes secrets.
- Output files open from the UI when they are inside authorized paths.

## Phase 7: Settings And Diagnostics

Goal: give small teams a maintainable local system.

- Add model provider settings, path settings, safety mode, and audit retention.
- Add diagnostics export for support.
- Add runtime health indicators.

Acceptance:
- User can update skill roots and model provider settings.
- User can export logs without exposing secrets.
- Diagnostics explain missing runtime or path problems in plain language.

## Phase 8: V1 Release Readiness

Goal: ship a stable Windows-first v1.

- Run Windows install smoke tests.
- Run skill scan, task run, approval, and evidence export tests.
- Test paths with spaces and Chinese characters.
- Prepare release notes and known limitations.

Acceptance:
- Installer, first-run doctor, skill execution, approval, and evidence flows pass on Windows 11.
- Known v1 exclusions are documented: mobile control, SaaS, public marketplace, enterprise RBAC.
