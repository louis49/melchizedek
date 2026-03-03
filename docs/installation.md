# Installation

This guide covers detailed installation options and hooks configuration for Melchizedek. For a quick start, see the [README](../README.md#quick-start).

## MCP Server Setup

### npm (global)

```bash
npm install -g melchizedek
```

**Option A - `claude mcp add` (simplest)**

```bash
claude mcp add --scope user melchizedek -- melchizedek-server
```

**Option B - `--mcp-config` file**

Create a file (e.g. `/tmp/melchizedek-mcp.json`):

```json
{
  "mcpServers": {
    "melchizedek": {
      "command": "melchizedek-server"
    }
  }
}
```

```bash
claude --mcp-config /tmp/melchizedek-mcp.json
```

### npx (no install)

**Option A - `claude mcp add`**

```bash
claude mcp add --scope user melchizedek -- npx melchizedek-server
```

**Option B - `--mcp-config` file**

Create a file (e.g. `/tmp/melchizedek-mcp.json`):

```json
{
  "mcpServers": {
    "melchizedek": {
      "command": "npx",
      "args": ["melchizedek-server"]
    }
  }
}
```

```bash
claude --mcp-config /tmp/melchizedek-mcp.json
```

### From source (contributors)

```bash
git clone https://github.com/louis49/melchizedek.git
cd melchizedek
npm install && npm run build
```

Then launch Claude Code with the generated `.mcp.json`:

```bash
claude --mcp-config .mcp.json
```

> **Note:** `npm run build` generates `.mcp.json` with absolute paths to `dist/server.js`. The `claude mcp add` command may not work reliably for source installs due to known Claude Code plugin bugs - `--mcp-config` is the tested method.

### Claude Code plugin marketplace

```bash
claude plugin install melchizedek
```

> **Note:** Plugin review is pending. In the meantime, use npm or npx install above.

## Setting up hooks (automatic indexing)

The MCP server provides search tools, but **hooks** are what trigger automatic indexing. Without hooks, you'd need to manually index sessions.

For **marketplace installs**, hooks are configured automatically. For npm/npx/source installs, add the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/session-end.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/session-end.js"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/session-start.js"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/dist/hooks/pre-compact.js"
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to` with the actual path to your Melchizedek installation:
- **npm global:** `$(npm root -g)/melchizedek`
- **Source:** your clone directory (e.g. `~/melchizedek`)

### Hook reference

| Hook | What it does |
|------|-------------|
| **SessionEnd / Stop** | Indexes the conversation transcript after each session |
| **SessionStart** | Injects recent context from past sessions into the new session |
| **PreCompact** | Indexes conversation chunks not yet indexed before `/compact` truncates the transcript |

After installation, restart Claude Code. Indexing starts automatically.

## Known Claude Code plugin bugs

These bugs affect plugin installation (as of March 2026):

| Bug | Impact | Workaround |
|-----|--------|------------|
| [#15308](https://github.com/anthropics/claude-code/issues/15308) | `--plugin-dir` doesn't load `.mcp.json` | Use `--mcp-config` or `claude mcp add` |
| [#16143](https://github.com/anthropics/claude-code/issues/16143) | `mcpServers` in `plugin.json` is ignored | Use standalone `.mcp.json` |
| [#9427](https://github.com/anthropics/claude-code/issues/9427) | `${CLAUDE_PLUGIN_ROOT}` doesn't expand | `npm run build` generates absolute paths |
| [#9427](https://github.com/anthropics/claude-code/issues/9427) | `--plugin-dir` doesn't load hooks | Add hooks to `~/.claude/settings.json` |
| [#13668](https://github.com/anthropics/claude-code/issues/13668) | `transcript_path` often empty in hooks | Reconstructed from `cwd` + `session_id` |
| [#16538](https://github.com/anthropics/claude-code/issues/16538) | `additionalContext` via plugin hooks ignored | Works only via `~/.claude/settings.json` |

## Troubleshooting

### MCP server not loading

1. Check `claude mcp list` - Melchizedek should appear
2. Try `melchizedek-server` directly - should output JSON-RPC on stdout
3. Use `--mcp-config` with a JSON file as a fallback

### Hooks not triggering

1. Verify hooks are in `~/.claude/settings.json` (not in a plugin directory)
2. Check paths are absolute and point to the correct `dist/hooks/*.js` files
3. Restart Claude Code after any hooks change
4. Check logs: `cat ~/.melchizedek/logs/melchizedek.log`
