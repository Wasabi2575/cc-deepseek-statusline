# deepseek-whale

A three-row status line for the Claude Code **terminal CLI**, with a hand-drawn blue DeepSeek whale on the left and live numbers on the right. It shows the model and context usage, prompt-cache hit rate, the real cost of the current session, your DeepSeek account balance, and whether DeepSeek is currently charging peak or off-peak rates.

```text
o  ▄▄▄                                            deepseek-flash · ctx 42%
o ▐███▌▐▌~~~                                       cache 91% · 会话 ¥0.35
 o▐█████                                            余额 ¥98.20 · 谷
```

> 🐋 The whale is hand-drawn by the author. Sorry if it looks a little rough — and thanks for trying it anyway.
>
> 鲸鱼是作者自己画的，不好看请见谅~

## Features

- **Three-line status line** — the whale occupies three rows on the left; the numbers are right-aligned, so they sit in the bottom-right corner of the terminal.
- **DeepSeek-priced session cost** — reads the session transcript (including subagent transcripts), deduplicates streamed messages, and applies DeepSeek's peak/off-peak prices per request. It does not trust Claude Code's Claude-priced `total_cost_usd`. The result is a local estimate, not an invoice.
- **Peak / off-peak indicator** — `峰` during DeepSeek's peak windows and `谷` otherwise, placed after the balance. Labels are configurable.
- **Account balance** — calls `GET https://api.deepseek.com/user/balance`, caches the result for 60 seconds, and refreshes in a detached child process so the status line never waits on the network.
- **Cache and context** — `cache 91%` comes from `prompt_cache.hit_ratio`; `ctx 42%` from `context_window.used_percentage`.
- **No dependencies** — one Node script, no npm packages.

## Requirements

- Claude Code with multi-line status line support (2.1.x or newer).
- Node.js 18 or newer.
- A DeepSeek API key reachable through `ANTHROPIC_AUTH_TOKEN` or `DEEPSEEK_API_KEY` if you want the balance row. The balance endpoint only exists on `api.deepseek.com`; a third-party relay needs a custom `balance.url`.

## Install as a Claude Code plugin

```bash
/plugin install deepseek-whale --marketplace Wasabi2575/cc-deepseek-statusline
/deepseek-whale:setup
```

Then restart Claude Code if the whale does not appear immediately. From a shell, the same install is:

```bash
claude plugin install deepseek-whale --marketplace Wasabi2575/cc-deepseek-statusline
```

The setup skill copies the script to `~/.claude/deepseek-whale/`, writes a default `config.json`, backs up `~/.claude/settings.json`, and adds:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"<node>\" \"<home>/.claude/deepseek-whale/statusline.js\"",
    "padding": 0,
    "refreshInterval": 30
  }
}
```

## Manual install

```bash
git clone https://github.com/Wasabi2575/cc-deepseek-statusline.git
cd cc-deepseek-statusline
node scripts/setup.js
```

Preview without touching settings:

```bash
node scripts/statusline.js --demo
```

Install with an existing settings backup check:

```bash
node scripts/setup.js --dry-run
node scripts/setup.js
```

## Configuration

Edit `~/.claude/deepseek-whale/config.json`:

```json
{
  "whale": true,
  "widthMargin": 6,
  "infoAlign": "right",
  "infoSeparator": " · ",
  "costCurrency": "CNY",
  "whaleArt": [
    "o  ▄▄▄      ",
    "o ▐███▌▐▌~~~",
    " o▐█████    "
  ],
  "whaleColors": [
    ["#4d6bfe", null, null, "#4d6bfe", "#4d6bfe", "#4d6bfe", null, null, null, null, null, null],
    ["#4d6bfe", null, "#4d6bfe", "#4d6bfe", "#4d6bfe", "#ffffff", "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe"],
    [null, "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe", "#4d6bfe", null, null, null, null]
  ],
  "whaleColor": "#4D6BFE",
  "whaleAccentColor": "#96B4FF",
  "whaleEyeColor": "#FFFFFF",
  "labels": {
    "session": "会话",
    "balance": "余额",
    "peak": "峰",
    "offPeak": "谷"
  },
  "balance": {
    "enabled": true,
    "url": "https://api.deepseek.com/user/balance",
    "refreshSeconds": 60,
    "timeoutMs": 2500
  },
  "pricing": {
    "deepseek-flash": {
      "peak":    { "input": 0.30, "output": 1.20, "cacheRead": 0.006, "cacheWrite": 0.30 },
      "offPeak": { "input": 0.15, "output": 0.60, "cacheRead": 0.003, "cacheWrite": 0.15 }
    },
    "deepseek-v4-pro": {
      "peak":    { "input": 1.32, "output": 3.96, "cacheRead": 0.044, "cacheWrite": 1.32 },
      "offPeak": { "input": 0.66, "output": 1.98, "cacheRead": 0.022, "cacheWrite": 0.66 }
    }
  },
  "pricingCny": {
    "deepseek-flash": {
      "peak":    { "input": 2, "output": 8, "cacheRead": 0.04, "cacheWrite": 2 },
      "offPeak": { "input": 1, "output": 4, "cacheRead": 0.02, "cacheWrite": 1 }
    },
    "deepseek-v4-pro": {
      "peak":    { "input": 9, "output": 27, "cacheRead": 0.30, "cacheWrite": 9 },
      "offPeak": { "input": 4.5, "output": 13.5, "cacheRead": 0.15, "cacheWrite": 4.5 }
    }
  },
  "holidays": []
}
```

The info block is right-aligned; the three rows have different lengths, so their left edges naturally differ.

`pricing` is USD per million tokens; `pricingCny` is CNY. `costCurrency` selects the table and symbol: `"CNY"` uses `pricingCny` and `¥`, `"USD"` uses `pricing` and `$`. Update both when DeepSeek changes its price sheet. `cacheWrite` matters only if your endpoint reports `cache_creation_input_tokens`; DeepSeek's automatic cache usually reports `0`.

The `会话` figure is the cumulative cost of the current session: every assistant request in the main transcript plus the subagent transcripts, priced per request at the rate in effect. It is **not** the last turn and **not** the tokens currently in the context window. It resets on `/clear` or a new session; `ctx` is the context-window usage.

`holidays` accepts `YYYY-MM-DD` dates in Beijing time. DeepSeek treats those weekdays as off-peak.

### Custom art

The icon lives in `whaleArt` (three strings) and `whaleColors` (optional per-cell hex colours) in `~/.claude/deepseek-whale/config.json`. Spaces stay transparent; characters without a colour use `whaleColor` / `whaleAccentColor` / `whaleEyeColor`.

### Balance key

The script resolves the key in this order:

1. `DEEPSEEK_API_KEY`
2. `apiKey` in `config.json`
3. `ANTHROPIC_AUTH_TOKEN`, but only when `ANTHROPIC_BASE_URL` contains `api.deepseek.com`

It never sends the key to a non-DeepSeek balance URL unless you set `balance.url` yourself.

## How the cost is computed

For every `assistant` entry in the main transcript and in `subagents/*.jsonl`:

```text
cost = input_tokens        × input rate
     + output_tokens       × output rate
     + cache_read_tokens   × cacheRead rate
     + cache_write_tokens  × cacheWrite rate
```

Each request is priced at the rate in effect at its own timestamp, then summed. Duplicate message IDs from streaming updates are collapsed, keeping the last usage block. Results are cached against the transcript's size and mtime.

## Limitations

- Claude Code does not officially support routing to non-Claude models. This plugin treats the transcript as data; the transcript format is internal and may change between releases. If parsing fails, cost shows `--` instead of a wrong number.
- Subagent transcripts are included when they live under `<session-id>/subagents/`. Other background work may not be.
- DeepSeek's balance endpoint is not available on third-party relays. Set `balance.enabled: false` or a custom `balance.url` in that case.
- Prices and peak windows can change; the defaults are current as of November 2026. The status line command embeds the absolute path to the Node binary used at setup time; if you upgrade or move Node, re-run `node scripts/setup.js`.
- Multi-line status lines with ANSI colors can occasionally render imperfectly in very narrow terminals; below roughly 56 columns the whale is hidden and only the text rows are shown.

## Uninstall

```bash
node ~/.claude/deepseek-whale/uninstall.js
# or, from a checkout:
node scripts/uninstall.js --purge
```

The uninstaller only removes a `statusLine` that points at `deepseek-whale`.

## Publishing this repository

```bash
git init
git add .
git commit -m "Release deepseek-whale v1.0.0"
gh repo create cc-deepseek-statusline --public --source=. --push
git push origin v1.0.0
```

Repository: https://github.com/Wasabi2575/cc-deepseek-statusline. The marketplace file is `.claude-plugin/marketplace.json`; the plugin manifest is `.claude-plugin/plugin.json`.

## License

MIT
