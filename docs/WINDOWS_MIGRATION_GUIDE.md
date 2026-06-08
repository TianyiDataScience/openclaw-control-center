# Windows Migration Guide

This guide explains how to move the OpenClaw Workbench prototype and local skill platform from macOS to Windows.

## 1. Target Layout

Recommended Windows paths:

```text
D:\Projects\openclaw-control-center
C:\Users\<you>\.openclaw
C:\Users\<you>\.openclaw\openclaw.json
C:\Users\<you>\.openclaw\skills
C:\Users\<you>\.codex\skills
C:\Users\<you>\.agents\skills
D:\OpenClaw\workspace
```

Keep project code, OpenClaw home, skills, and task workspaces separate. This makes backup, permission review, and cleanup much easier.

## 2. Install Windows Prerequisites

Run in PowerShell:

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
```

Verify:

```powershell
node -v
npm -v
git --version
```

Use Node LTS for the first migration. Avoid experimental Node versions until the desktop shell and package build are stable.

## 3. Copy The Project

Copy the repository to:

```text
D:\Projects\openclaw-control-center
```

Then install dependencies:

```powershell
cd D:\Projects\openclaw-control-center
npm install
```

If Electron dependencies are not installed yet:

```powershell
npm install --save-dev electron electron-builder
```

## 4. Copy OpenClaw Data

Copy these local directories from macOS to Windows:

```text
/Users/dorom/.openclaw/skills  ->  C:\Users\<you>\.openclaw\skills
/Users/dorom/.codex/skills     ->  C:\Users\<you>\.codex\skills
/Users/dorom/.agents/skills    ->  C:\Users\<you>\.agents\skills
```

Copy `openclaw.json` only after reviewing it. Do not blindly keep macOS paths.

Examples:

```text
/Users/dorom/.openclaw/workspace-main
```

should become something like:

```text
D:\OpenClaw\workspace-main
```

Also review model provider secrets. Prefer re-entering secrets on Windows instead of copying old plaintext config.

## 5. Create A Windows `.env`

Create `.env` from `.env.example`, then use Windows paths:

```powershell
copy .env.example .env
```

Recommended overrides:

```text
OPENCLAW_HOME=C:\Users\<you>\.openclaw
OPENCLAW_CONFIG_PATH=C:\Users\<you>\.openclaw\openclaw.json
OPENCLAW_WORKSPACE_ROOT=D:\OpenClaw\workspace
LOCAL_TOKEN_AUTH_REQUIRED=true
LOCAL_API_TOKEN=<set-a-long-random-local-token>
READONLY_MODE=true
```

Keep `READONLY_MODE=true` until the first task flow is proven.

## 6. Run Migration Checks

Run:

```powershell
npm run desktop:doctor
```

Expected result:

- OpenClaw config is readable.
- At least one skill root exists.
- Skills are counted.
- Workspace root exists or shows a clear warning.
- Windows-only warnings are understandable.

If the doctor reports old macOS paths, fix `openclaw.json` or `.env` before continuing.

## 7. Open The Prototype

Static prototype:

```text
D:\Projects\openclaw-control-center\docs\prototypes\windows-skill-platform.html
```

Desktop shell:

```powershell
npm run desktop:dev
```

The desktop shell loads the same prototype and calls the local doctor through IPC.

## 8. Build A Windows Installer

After the desktop shell opens successfully:

```powershell
npm run desktop:dist:win
```

Expected output:

```text
release\OpenClaw Workbench Setup <version>.exe
```

Use the installer only after `desktop:doctor` and `desktop:dev` both work.

## 9. Common Migration Problems

### `openclaw.json` still points to `/Users/dorom`

Fix all workspace, agentDir, skill, and local file references to Windows paths.

### Skill scan finds zero skills

Check:

```text
C:\Users\<you>\.openclaw\skills\<skill-name>\SKILL.md
```

The scanner counts directories that contain `SKILL.md`.

### Workspace path has spaces or Chinese characters

This is supported by the desktop doctor and should remain supported by implementation. Do not convert paths by string concatenation in future code.

### PowerShell blocks scripts

Do not globally weaken execution policy for the whole machine. Prefer running signed installer flows or explicit one-time approvals inside the app.

### API keys appear in copied config

Remove or rotate old keys. The Windows app should move secrets into Windows Credential Manager in a later slice.

## 10. Migration Done Criteria

Migration is complete when:

- `npm run desktop:doctor` has no failed checks.
- `npm run desktop:dev` opens the prototype window.
- The prototype shows live doctor status in the left runtime panel.
- The selected workspace exists on Windows.
- Local skills are discovered.
- No macOS `/Users/dorom/...` paths remain in active Windows config.
