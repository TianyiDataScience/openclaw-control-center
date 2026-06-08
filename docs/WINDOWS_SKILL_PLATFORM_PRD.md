# Windows Local Skill Platform PRD

## 1. Product Summary

Build a Windows-first local desktop platform that lets a user install, select, authorize, and run OpenClaw-compatible skills from a simple WorkBuddy-like interface. The first version focuses on a reliable single-machine or small-team workflow: choose a skill, grant a workspace folder, describe a task in natural language, run it through the OpenClaw runtime, and review outputs, logs, and safety prompts.

The product is not a hosted SaaS and not a replacement for OpenClaw. It is a local deployment layer and operator experience around OpenClaw skills.

## 2. References

- WorkBuddy official overview: https://www.codebuddy.cn/docs/workbuddy/Overview
- WorkBuddy official product guide: https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Product-Guide
- WorkBuddy task bar / skills documentation: https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar
- Existing local OpenClaw Control Center: `/Users/dorom/openclaw-control-center`
- Existing OpenClaw runtime config root: `~/.openclaw`

## 3. Target Users

Primary users:
- The owner and a small trusted team running local OpenClaw on Windows.
- Users who want WorkBuddy-like task execution without relying on a hosted cloud product.
- Users who already have OpenClaw-compatible skills and want a safer, clearer desktop experience.

Secondary users:
- Developers or agent builders who need logs, skill metadata, and execution evidence.

Out of scope for v1:
- Public multi-tenant SaaS.
- Enterprise account hierarchy and centralized policy management.
- Full mobile remote-control experience.
- A full WorkBuddy clone with all office scenarios on day one.

## 4. Goals And Success Metrics

Goals:
- A non-technical user can install the Windows app and complete first-run setup in under 10 minutes.
- The app can discover local skills from common directories and run at least one skill-backed task end to end.
- Every task has a visible status, workspace, selected skill, outputs, and execution log.
- High-risk operations require confirmation before execution.
- Secrets and model configuration remain local.

Success metrics:
- 90 percent first-run setup success on a clean Windows 11 machine with prerequisites available or installable.
- First useful task completed within 3 minutes after setup.
- All file writes occur only inside authorized folders unless explicitly approved.
- Every completed task records enough evidence to reproduce what ran.

## 5. V1 User Journey

1. User installs the Windows app from a one-click installer.
2. App runs a first-start doctor:
   - Checks OpenClaw home, runtime, Node, PowerShell execution policy, model provider config, and writable workspace path.
   - Offers guided fixes where possible.
3. User opens the Skill Library.
4. App scans local skill sources:
   - `~/.openclaw/skills`
   - `~/.codex/skills`
   - `~/.agents/skills`
   - manually imported folders or zip packages
5. User selects a skill card and sees:
   - purpose
   - required inputs
   - likely file permissions
   - runtime requirements
6. User chooses or creates a task workspace folder.
7. User writes a natural-language request and starts the task.
8. App sends the request, selected skill, workspace, and safety constraints to OpenClaw.
9. During execution, app shows:
   - current step
   - files read/written
   - commands requested
   - confirmation prompts for high-risk actions
10. User reviews outputs in a result panel:
   - generated files
   - text answer
   - change list
   - logs and replay evidence

## 6. Functional Requirements

### 6.1 Windows Installer And First-Run Setup

- Provide a Windows one-click installer.
- Create a default local app data directory under `%LOCALAPPDATA%`.
- Detect existing OpenClaw configuration, or guide the user to create one.
- Support Windows path rules, including spaces, Chinese characters, and backslashes.
- Provide a doctor page with pass/warn/fail checks and concrete fix buttons.
- Support launching the local UI automatically after install.

### 6.2 Skill Library

- Scan local skill directories and parse `SKILL.md`.
- Show skill cards with name, description, source path, install status, and compatibility warnings.
- Allow importing a local folder or zip as a skill.
- Deduplicate skills with the same name and show source priority.
- Provide a search and filter UI for skill name, domain, and source.
- Do not execute skill code during indexing.

### 6.3 Task Runner

- Let the user start a task with:
  - prompt
  - selected skill
  - authorized workspace folder
  - optional model/provider
- Use OpenClaw as the execution backend.
- Persist task state locally:
  - queued
  - running
  - waiting for approval
  - completed
  - failed
  - cancelled
- Show a live task timeline with concise human-readable events.
- Allow canceling a running task when the backend supports it.

### 6.4 Local Permission And Safety Layer

- Require explicit folder authorization before file operations.
- Require user confirmation for high-risk operations, including:
  - deleting files or folders
  - modifying files outside the authorized workspace
  - running shell commands that change system configuration
  - installing packages
  - network calls from unknown skill sources
- Store model keys and local tokens using Windows Credential Manager or an encrypted local store.
- Keep local audit logs for task starts, approvals, denials, file outputs, and errors.

### 6.5 Results And Evidence

- Show generated artifacts in a result panel.
- Group files by created, modified, read, and referenced.
- Provide an execution summary after each task.
- Save replayable evidence locally, including prompt, skill id, workspace, timestamps, approvals, and final outputs.
- Allow exporting a task evidence bundle as JSON plus Markdown.

### 6.6 Settings

- Model provider settings:
  - provider name
  - base URL
  - model id
  - local credential reference
- OpenClaw paths:
  - home directory
  - workspace root
  - skill roots
- Safety settings:
  - approval required mode
  - allowed workspace roots
  - audit retention
- Diagnostics:
  - runtime health
  - skill scan health
  - last error
  - log export

## 7. Non-Functional Requirements

- Local-first: app must run without hosted backend.
- Windows-first: Windows 11 is the target for v1; Windows 10 can be best effort.
- Safe defaults: readonly/indexing operations must not mutate skills or OpenClaw config.
- Resilient paths: all file logic must use path APIs, not string concatenation.
- Human-readable errors: setup and runtime errors must explain cause and next step.
- Sensitive data: never display full API keys in logs, exports, or UI.
- Performance: scanning 200 skills should complete in under 5 seconds on a normal SSD.

## 8. Recommended Architecture

### Desktop Shell

Use an Electron or Tauri desktop shell with a local web UI. The shell owns installer integration, tray behavior, local file picker, credential storage, and Windows-specific permissions.

Recommended default: Electron for faster delivery because the existing local projects already use Node, TypeScript, and web UI patterns.

### Local Backend

Use a Node/TypeScript local service that:
- indexes skills
- exposes local HTTP/WebSocket APIs to the UI
- bridges to OpenClaw
- records task state and evidence
- enforces approval gates

Reuse concepts from `openclaw-control-center` where possible, especially local token auth, runtime status, task evidence, readonly defaults, and diagnostics.

### OpenClaw Runtime Adapter

Add a thin adapter around official OpenClaw interfaces first. The adapter should translate desktop task requests into OpenClaw-compatible execution inputs and normalize status/events back into the desktop UI.

### Local Storage

Use local JSON or SQLite for v1:
- skills index
- task records
- approvals
- evidence bundles
- settings excluding secrets

Secrets must live in Windows Credential Manager or encrypted OS-backed storage.

## 9. Windows Adaptation Requirements

- Use `%USERPROFILE%` and `%LOCALAPPDATA%` instead of Unix-only assumptions.
- Resolve `~` explicitly for Windows.
- Support PowerShell command execution and avoid Bash-only scripts.
- Replace shell chained commands with direct process spawning where possible.
- Support paths with spaces and non-ASCII characters.
- Provide a Windows doctor check for:
  - Node runtime availability
  - OpenClaw config readability
  - workspace write permission
  - PowerShell policy constraints
  - long path support warning
  - firewall/local port conflicts
- Installer should create Start Menu shortcut and optional tray auto-start.

## 10. V1 MVP Scope

Must have:
- Windows installer
- first-run doctor
- local skill discovery
- skill detail page
- task creation with one selected skill
- authorized workspace folder
- OpenClaw execution bridge
- live task status
- approval prompts for risky actions
- result and evidence view
- settings and diagnostics

Should have:
- manual skill import
- task history search
- evidence export
- model provider selector
- tray status

Could have:
- local skill marketplace index
- scheduled tasks
- multi-agent handoff
- LAN access from phone

Will not have in v1:
- cloud sync
- mobile app
- enterprise RBAC
- public skill marketplace publishing
- collaborative multi-user workspace

## 11. Acceptance Criteria

- On a clean Windows 11 test machine, installing the app opens the first-run doctor successfully.
- The app can discover at least one local OpenClaw-compatible skill from a configured skill root.
- The user can run a task using that skill against an authorized folder.
- The app blocks or prompts before a high-risk file or command operation.
- The final task screen shows outputs, task status, execution summary, and evidence.
- API keys are masked in UI, logs, and exported evidence.
- The same task flow works when the workspace path contains spaces and Chinese characters.

## 12. Assumptions

- v1 prioritizes the owner's machine and a small trusted team, not public SaaS.
- OpenClaw remains the execution runtime.
- Skill sources are local directories first; remote marketplace support is deferred.
- Security defaults are conservative.
- Windows one-click installer is the primary distribution channel.
- Mobile/IM remote control is deferred to v1.1.
