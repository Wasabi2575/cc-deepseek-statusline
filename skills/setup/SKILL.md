---
name: setup
description: Install or update the DeepSeek whale status line (copies the script to ~/.claude/deepseek-whale and writes statusLine into ~/.claude/settings.json)
allowed-tools: Bash(node:*)
---

Run the installer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js"
```

The installer:

- copies `statusline.js` to `~/.claude/deepseek-whale/statusline.js`
- creates `~/.claude/deepseek-whale/config.json` if it does not exist
- backs up `~/.claude/settings.json`
- adds a `statusLine` entry pointing at the copied script

After it runs, tell the user:

- The whale appears at the bottom of Claude Code; restart Claude Code if it does not show up immediately.
- Prices and labels live in `~/.claude/deepseek-whale/config.json`.
- Balance uses `DEEPSEEK_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` when `ANTHROPIC_BASE_URL` points at `api.deepseek.com`.
- To update after a plugin upgrade, run this setup again.
- To uninstall: `node "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.js"`.
