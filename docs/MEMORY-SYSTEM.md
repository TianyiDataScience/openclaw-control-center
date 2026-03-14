# Memory System Configuration Guide

## Overview

OpenClaw can use different memory storage systems. This guide explains how to configure OpenClaw Control Center to work with your memory setup.

## Memory System Types

### 1. File-System Memory (Default)

Memory stored as markdown files in the workspace directory.

**Location:** `OPENCLAW_WORKSPACE_ROOT/memory/`

**Supported by Control Center:** ✅ Full support (browse, edit, create)

**File Structure:**
```
~/.openclaw/workspace/
├── MEMORY.md          # Main long-term memory
├── memory/
│   ├── 2026-03-13.md  # Daily memory files
│   └── ...
└── agents/
    └── [agent-id]/
        ├── MEMORY.md  # Agent-specific memory
        └── memory/
            └── ...
```

### 2. LanceDB Vector Memory (Advanced)

Memory stored in LanceDB vector database for semantic search and retrieval.

**Location:** `~/.openclaw/memory/lancedb-pro/`

**Supported by Control Center:** ⚠️ Read-only through OpenClaw Gateway

**Note:** Control Center's memory browsing feature shows file-system memory only. LanceDB memories are accessed through OpenClaw's vector search tools and are not directly displayed in the UI.

### 3. Dual Memory System (Recommended)

Many OpenClaw installations use both systems:
- **LanceDB** for vector-based semantic search and retrieval
- **File-system** for persistent, human-readable memory storage

## Configuration

### Step 1: Identify Your Memory Location

Check where your OpenClaw stores memory files:

```bash
# Check for file-system memory
ls -la ~/.openclaw/workspace/memory/

# Check for LanceDB memory
ls -la ~/.openclaw/memory/lancedb-pro/

# Check your OpenClaw config
cat ~/.openclaw/openclaw.json | grep -A 10 "memory"
```

### Step 2: Configure Control Center

Edit `.env` in the control-center directory:

```bash
# For standard workspace location (~/.openclaw/workspace)
OPENCLAW_WORKSPACE_ROOT=/Users/YOUR_USERNAME/.openclaw/workspace

# For custom workspace location
OPENCLAW_WORKSPACE_ROOT=/path/to/your/workspace

# OpenClaw home directory (usually auto-detected)
OPENCLAW_HOME=/Users/YOUR_USERNAME/.openclaw
```

### Step 3: Verify Configuration

```bash
# Restart the control center
cd ~/dev/openclaw-control-center
npm run build
UI_MODE=true npm run dev

# Test the API
curl "http://127.0.0.1:4310/api/files?scope=memory"
```

Expected response should show your memory files.

## Troubleshooting

### No Memory Files Showing

**Problem:** Memory section shows "当前没有可编辑的记忆文件"

**Solution 1:** Check if workspace path is correct
```bash
# Check the calculated path
cd ~/dev/openclaw-control-center
node -e "console.log(require('path').resolve(process.cwd(), '..', '..', '..'))"

# If it shows wrong path, set OPENCLAW_WORKSPACE_ROOT in .env
```

**Solution 2:** Create symbolic link (alternative method)
```bash
ln -sf ~/.openclaw/workspace ~/dev/workspace
```

**Solution 3:** Verify memory files exist
```bash
ls -la ~/.openclaw/workspace/memory/
# or check your actual workspace path
```

### LanceDB Memories Not Showing

This is expected behavior. LanceDB memories are:
- Stored in binary vector format
- Accessed through OpenClaw's semantic search tools
- Not displayed as files in Control Center

To work with LanceDB memories:
- Use OpenClaw's `memory_recall` tool
- Access through OpenClaw CLI or API
- LanceDB contents are reflected in OpenClaw's behavior, not as separate files

### Mixed Memory Systems

If you have both LanceDB and file-system memory:

1. **File-system memories** appear in Control Center's Memory section
2. **LanceDB memories** are used by OpenClaw internally and affect behavior
3. Both systems work together - LanceDB for search, files for persistence

## Memory Editing

### Editing File-System Memory

1. Navigate to Memory section in Control Center
2. Select the memory file you want to edit
3. Edit content in the browser
4. Click Save - changes are written directly to the source file

**Note:** Edits are immediately available to OpenClaw agents.

### Memory File Types Supported

- `.md` - Markdown files
- `.markdown` - Markdown files (alternative extension)
- `.txt` - Plain text files

## Advanced Configuration

### Custom Workspace Structure

If your workspace has a non-standard structure:

```env
# Point to your actual workspace root
OPENCLAW_WORKSPACE_ROOT=/custom/path/to/workspace

# Control Center will look for:
# - {WORKSPACE_ROOT}/MEMORY.md
# - {WORKSPACE_ROOT}/memory/
# - {WORKSPACE_ROOT}/agents/{agent-id}/MEMORY.md
```

### Multiple Workspaces

For multiple OpenClaw installations:

1. Create separate Control Center installations for each
2. Configure each with different `OPENCLAW_WORKSPACE_ROOT`
3. Use different `UI_PORT` values to avoid conflicts

## API Endpoints

### List Memory Files
```bash
GET /api/files?scope=memory
```

### Read Memory File
```bash
GET /api/files/content?scope=memory&path=/absolute/path/to/file.md
```

### Update Memory File
```bash
PUT /api/files/content
Content-Type: application/json
{
  "scope": "memory",
  "path": "/absolute/path/to/file.md",
  "content": "New file content"
}
```

## Best Practices

1. **Use descriptive filenames** for daily memories (e.g., `2026-03-13.md`)
2. **Organize by agent** when using multiple agents
3. **Keep MEMORY.md** for high-level, persistent knowledge
4. **Use memory/ directory** for temporal, dated entries
5. **Backup regularly** - Control Center doesn't auto-backup memory files

## Memory System Comparison

| Feature | File-System | LanceDB |
|---------|-------------|---------|
| Human Readable | ✅ Yes | ❌ No |
| Browse in UI | ✅ Yes | ❌ No |
| Edit in UI | ✅ Yes | ❌ No |
| Semantic Search | ❌ No | ✅ Yes |
| Vector Similarity | ❌ No | ✅ Yes |
| Git Versionable | ✅ Yes | ❌ No |
| Backup | Simple copy | Database dump |

## Support

For issues or questions:
1. Check this guide's troubleshooting section
2. Review OpenClaw documentation
3. Check Control Center logs: `tail -f /tmp/openclaw-ui.log`
4. Verify Gateway connection: Check `GATEWAY_URL` in `.env`
