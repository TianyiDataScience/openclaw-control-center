# OpenClaw Workbench Desktop Shell

This directory contains the Windows-first desktop shell for the local skill platform.

## Current Slice

- `main.cjs` opens the approved HTML prototype inside a secure Electron window.
- `preload.cjs` exposes a small IPC surface to the renderer.
- `doctor.cjs` runs the first-run environment checks without mutating OpenClaw state.

## Local Checks

Run the doctor without Electron:

```bash
npm run desktop:doctor
```

Run the desktop shell after Electron is installed:

```bash
npm run desktop:dev
```

Build a Windows installer from a Windows machine:

```bash
npm run desktop:dist:win
```

The shell currently loads `docs/prototypes/windows-skill-platform.html`. Runtime integration with OpenClaw execution is intentionally deferred to the next slice.

For migration details, see `docs/WINDOWS_MIGRATION_GUIDE.md`.
