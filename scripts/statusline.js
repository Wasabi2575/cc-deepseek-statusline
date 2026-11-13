#!/usr/bin/env node
'use strict';

/**
 * deepseek-whale status line for Claude Code.
 *
 * Reads the status-line JSON on stdin, prints three rows:
 *   [blue whale]                         model · ctx
 *   [blue whale]                         cache · session cost
 *   [blue whale]                         balance · peak/off-peak
 *
 * Cost is computed locally from the session transcript using DeepSeek's
 * peak/off-peak prices. Balance comes from DeepSeek's /user/balance API and
 * is cached in the background so the status line never waits on the network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOME = os.homedir();
const ROOT = path.join(HOME, '.claude', 'deepseek-whale');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BALANCE_CACHE = path.join(ROOT, 'balance-cache.json');
const COST_CACHE = path.join(ROOT, 'cost-cache.json');
const REFRESH_LOCK = path.join(ROOT, 'balance-refresh.lock');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  blue: '\x1b[38;2;77;107;254m',      // DeepSeek blue #4D6BFE
  lightBlue: '\x1b[38;2;150;180;255m',
  white: '\x1b[97m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

const DEFAULT_CONFIG = {
  whale: true,
  // Claude Code adds padding around the status line and may reserve columns
  // on the right. Leave a margin so its renderer does not clip the text.
  widthMargin: 6,
  // Three lines of plain text. `o` is the eye (white), `~` is the accent
  // colour (belly / water). Everything else uses whaleColor.
  whaleArt: [
    'o  ▄▄▄      ',
    'o ▐███▌▐▌~~~',
    ' o▐█████    ',
  ],
  whaleColors: [
    ['#4d6bfe', null, null, '#4d6bfe', '#4d6bfe', '#4d6bfe', null, null, null, null, null, null],
    ['#4d6bfe', null, '#4d6bfe', '#4d6bfe', '#4d6bfe', '#ffffff', '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe'],
    [null, '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe', '#4d6bfe', null, null, null, null],
  ],
  whaleColor: '#4D6BFE',
  whaleAccentColor: '#96B4FF',
  whaleEyeColor: '#FFFFFF',
  labels: {
    session: '会话',
    balance: '余额',
    peak: '峰',
    offPeak: '谷',
  },
  infoSeparator: ' · ',
  // "right" aligns the three info rows on their right edge; "left" aligns
  // their left edge instead.
  infoAlign: 'right',
  balance: {
    enabled: true,
    url: 'https://api.deepseek.com/user/balance',
    refreshSeconds: 60,
    timeoutMs: 2500,
  },
  // USD per million tokens. DeepSeek publishes peak and off-peak rates.
  pricing: {
    'deepseek-flash': {
      peak: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0.30 },
      offPeak: { input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0.15 },
    },
    'deepseek-v4-pro': {
      peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
      offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66 },
    },
  },
  // CNY per million tokens, from DeepSeek's Chinese price sheet.
  pricingCny: {
    'deepseek-flash': {
      peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
      offPeak: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 1 },
    },
    'deepseek-v4-pro': {
      peak: { input: 9, output: 27, cacheRead: 0.30, cacheWrite: 9 },
      offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 4.5 },
    },
  },
  // "CNY" uses pricingCny and ¥; "USD" uses pricing and $.
  costCurrency: 'CNY',
  // Optional list of Chinese public holidays as YYYY-MM-DD (Beijing date).
  // DeepSeek treats those weekdays as off-peak.
  holidays: [],
};

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, value) {
  try {
    ensureDir(p);
    fs.writeFileSync(p, JSON.stringify(value));
  } catch {}
}

function merge(base, override) {
  if (override === undefined) return base;
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const [k, v] of Object.entries(override)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(out[k], v) : v;
  }
  return out;
}

function loadConfig() {
  const user = readJson(CONFIG_PATH) || {};
  // Used by scripts/whale-studio.js to preview artwork before saving it.
  if (process.env.DEEPSEEK_WHALE_ART) {
    try {
      const art = JSON.parse(process.env.DEEPSEEK_WHALE_ART);
      if (Array.isArray(art) && art.length === 3) user.whaleArt = art.map(String);
    } catch {}
  }
  if (process.env.DEEPSEEK_WHALE_COLORS) {
    try {
      const colors = JSON.parse(process.env.DEEPSEEK_WHALE_COLORS);
      if (Array.isArray(colors) && colors.length === 3) user.whaleColors = colors;
    } catch {}
  }
  return merge(DEFAULT_CONFIG, user);
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/* terminal width / CJK-aware padding                                  */
/* ------------------------------------------------------------------ */

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\]8;;[^\x07]*\x07/g, '');
}

function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

function truncateVisible(s, max) {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > max - 1) { out += '…'; break; }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + C.reset;
}

/* ------------------------------------------------------------------ */
/* DeepSeek peak / off-peak                                            */
/* ------------------------------------------------------------------ */

function beijingDate(d) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return '';
  }
}

// Peak: Monday-Friday, 01:00-04:00 and 06:00-10:00 UTC.
// Chinese public holidays are off-peak; list them in config.holidays.
function isPeak(date, holidays) {
  const d = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 0 || day === 6) return false;
  if (Array.isArray(holidays) && holidays.length) {
    const bj = beijingDate(d);
    if (bj && holidays.includes(bj)) return false;
  }
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/* ------------------------------------------------------------------ */
/* session cost from the transcript                                    */
/* ------------------------------------------------------------------ */

function normalizeModel(m) {
  return String(m || '').replace(/\[(1m|1M)\]$/i, '').trim().toLowerCase();
}

function ratesFor(model, pricing) {
  const mm = normalizeModel(model);
  for (const [key, value] of Object.entries(pricing || {})) {
    if (normalizeModel(key) === mm) return value;
  }
  return null;
}

function collectTranscriptFiles(mainPath, sessionId) {
  const files = [];
  if (mainPath && fs.existsSync(mainPath)) files.push(mainPath);

  // Subagents keep their own transcripts next to the session transcript:
  //   <project>/<session-id>/subagents/agent-*.jsonl
  if (mainPath) {
    const dir = sessionId
      ? path.join(path.dirname(mainPath), sessionId, 'subagents')
      : path.join(path.dirname(mainPath), path.basename(mainPath, '.jsonl'), 'subagents');
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
      }
    };
    walk(dir);
  }
  return files;
}

function computeSessionCost(transcriptPath, sessionId, cfg) {
  const files = collectTranscriptFiles(transcriptPath, sessionId);
  if (!files.length) return null;

  const fileStats = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      fileStats.push(`${path.resolve(file)}:${st.mtimeMs}:${st.size}`);
    } catch {}
  }

  const pricing = (cfg.costCurrency === 'CNY' && cfg.pricingCny && Object.keys(cfg.pricingCny).length)
    ? cfg.pricingCny
    : (cfg.pricing || {});

  const cacheKey = crypto.createHash('sha1').update([
    fileStats.join('|'),
    JSON.stringify(pricing),
    cfg.costCurrency || 'USD',
    (cfg.holidays || []).join(','),
  ].join('|')).digest('hex');

  const cache = readJson(COST_CACHE) || {};
  if (cache[cacheKey]) return cache[cacheKey];

  // The transcript can contain several entries for the same message id
  // (streaming updates). The last entry carries the final usage block.
  const seen = new Map();
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'assistant') continue;
      const message = entry.message;
      if (!message || !message.usage) continue;
      const id = message.id || entry.uuid;
      if (!id) continue;
      seen.set(id, {
        usage: message.usage,
        model: message.model || entry.requestedModel || entry.model,
        timestamp: entry.timestamp,
      });
    }
  }

  let total = 0;
  let known = 0;
  let unknown = 0;

  for (const rec of seen.values()) {
    const rates = ratesFor(rec.model, pricing);
    if (!rates) { unknown++; continue; }
    const peak = isPeak(rec.timestamp ? new Date(rec.timestamp) : new Date(), cfg.holidays);
    const r = (peak ? rates.peak : rates.offPeak) || rates.offPeak || rates.peak;
    if (!r) { unknown++; continue; }

    const u = rec.usage;
    total += (
      num(u.input_tokens) * num(r.input) +
      num(u.output_tokens) * num(r.output) +
      num(u.cache_read_input_tokens) * num(r.cacheRead) +
      num(u.cache_creation_input_tokens) * num(r.cacheWrite)
    ) / 1e6;
    known++;
  }

  const result = { at: Date.now(), total, known, unknown, requests: seen.size };

  // Keep only the most recent 20 transcript entries.
  cache[cacheKey] = result;
  const keep = Object.keys(cache)
    .sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0))
    .slice(0, 20);
  const pruned = {};
  for (const k of keep) pruned[k] = cache[k];
  writeJson(COST_CACHE, pruned);

  return result;
}

/* ------------------------------------------------------------------ */
/* DeepSeek balance                                                    */
/* ------------------------------------------------------------------ */

function settingsEnv() {
  const settings = readJson(SETTINGS_PATH) || {};
  return settings.env || {};
}

function resolveApiKey(cfg) {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (cfg.apiKey) return cfg.apiKey;
  const env = { ...settingsEnv(), ...process.env };
  const base = String(env.ANTHROPIC_BASE_URL || '');
  // Only send the Claude Code token to DeepSeek's official host.
  if (base.includes('api.deepseek.com')) return env.ANTHROPIC_AUTH_TOKEN || '';
  return '';
}

function httpGetJson(urlString, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) { reject(e); return; }
    const mod = url.protocol === 'http:' ? http : https;
    // Pass an options object and force IPv4. Passing the URL object itself
    // made some Windows/Node combinations hang during DNS/TLS setup.
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      family: 4,
      headers,
      timeout: timeoutMs,
    };
    if (url.protocol === 'https:') options.servername = url.hostname;
    const req = mod.get(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function balanceIsFresh(cache, cfg) {
  return Boolean(cache) && Date.now() - (cache.at || 0) < (cfg.balance.refreshSeconds || 60) * 1000;
}

function spawnBalanceRefresh(cfg) {
  try {
    if (!cfg.balance.enabled) return;
    if (!resolveApiKey(cfg)) return;

    const lock = readJson(REFRESH_LOCK) || {};
    if (Date.now() - (lock.at || 0) < 20000) return;

    writeJson(REFRESH_LOCK, { at: Date.now(), pid: process.pid });
    const child = spawn(process.execPath, [__filename, '--refresh-balance'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {}
}

async function refreshBalanceMode() {
  const cfg = loadConfig();
  const key = resolveApiKey(cfg);
  if (!cfg.balance.enabled || !key) return;

  try {
    const data = await httpGetJson(
      cfg.balance.url || DEFAULT_CONFIG.balance.url,
      { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      cfg.balance.timeoutMs || 2500
    );
    const info = (data.balance_infos || [])[0];
    if (!info) throw new Error('no balance_infos');
    writeJson(BALANCE_CACHE, {
      at: Date.now(),
      currency: info.currency,
      total: info.total_balance,
      available: data.is_available !== false,
    });
  } catch (e) {
    const old = readJson(BALANCE_CACHE);
    if (old) {
      writeJson(BALANCE_CACHE, {
        ...old,
        lastError: String((e && e.message) || e),
        lastErrorAt: Date.now(),
      });
    }
  } finally {
    try { fs.unlinkSync(REFRESH_LOCK); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

function hexToAnsi(hex, fallback) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function whaleLines(cfg) {
  const art = (Array.isArray(cfg.whaleArt) && cfg.whaleArt.length === 3)
    ? cfg.whaleArt.map((line) => String(line))
    : DEFAULT_CONFIG.whaleArt;
  const colors = (Array.isArray(cfg.whaleColors) && cfg.whaleColors.length === 3)
    ? cfg.whaleColors
    : null;
  const width = Math.max(...art.map(displayWidth));
  const body = hexToAnsi(cfg.whaleColor, C.blue);
  const accent = hexToAnsi(cfg.whaleAccentColor, C.lightBlue);
  const eye = hexToAnsi(cfg.whaleEyeColor, C.white);

  return art.map((line, row) => {
    const padded = line + ' '.repeat(Math.max(0, width - displayWidth(line)));
    const chars = Array.from(padded);
    let out = '';
    let current = null;

    for (let col = 0; col < chars.length; col++) {
      const ch = chars[col];
      if (ch === ' ') {
        out += ' ';
        current = null;
        continue;
      }

      const custom = colors && Array.isArray(colors[row]) ? colors[row][col] : null;
      let color;
      if (typeof custom === 'string' && custom) color = hexToAnsi(custom, body);
      else if (ch === 'o') color = eye;
      else if (ch === '~') color = accent;
      else color = body;

      if (color !== current) {
        out += color;
        current = color;
      }
      out += ch;
    }

    return out + C.reset;
  });
}

function fmtCost(cost, cfg) {
  if (!cost || !cost.known) return '--';
  const symbol = cfg.costCurrency === 'CNY' ? '¥' : '$';
  const n = cost.total;
  let s;
  if (n < 0.01) s = symbol + n.toFixed(4);
  else if (n < 1) s = symbol + n.toFixed(3);
  else s = symbol + n.toFixed(2);
  return cost.unknown ? s + '+?' : s;
}

function fmtBalance(balance, cfg) {
  const label = cfg.labels.balance;
  if (!balance) return { text: `${label} --`, color: C.gray };
  if (balance.available === false) return { text: `${label} 不可用`, color: C.red };

  const currency = balance.currency;
  const symbol = currency === 'USD' ? '$' : (currency === 'CNY' ? '¥' : `${currency} `);
  const value = Number(balance.total);
  const amount = Number.isFinite(value) ? value.toFixed(2) : String(balance.total);
  const stale = Date.now() - (balance.at || 0) > (cfg.balance.refreshSeconds || 60) * 1000 * 2;
  return { text: `${label} ${symbol}${amount}${stale ? '~' : ''}`, color: C.green };
}

function main() {
  const cfg = loadConfig();
  const demo = process.argv.includes('--demo');

  let input = {};
  if (!demo) {
    if (!process.stdin.isTTY) {
      try {
        const raw = fs.readFileSync(0, 'utf8');
        input = raw ? JSON.parse(raw) : {};
      } catch {
        input = {};
      }
    }
  }

  if (demo) {
    input = {
      session_id: 'demo',
      transcript_path: '',
      model: { id: 'deepseek-flash', display_name: 'deepseek-flash' },
      workspace: { current_dir: process.cwd() },
      context_window: { used_percentage: 42, context_window_size: 1000000 },
      prompt_cache: { hit_ratio: 0.91, warm: true },
      cost: { total_cost_usd: 0 },
    };
  }

  const model = input.model && (input.model.display_name || input.model.id)
    ? (input.model.display_name || input.model.id)
    : 'claude';

  const contextWindow = input.context_window || {};
  let pct = Number(contextWindow.used_percentage);
  if (!Number.isFinite(pct)) {
    const usage = contextWindow.current_usage || {};
    const size = Number(contextWindow.context_window_size) || 0;
    const used = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    pct = size ? Math.round((used / size) * 100) : 0;
  }
  pct = Math.max(0, Math.min(999, Math.round(pct)));

  let hit = input.prompt_cache && input.prompt_cache.hit_ratio;
  if (hit !== undefined && hit !== null && Number.isFinite(Number(hit))) {
    hit = Number(hit);
    if (hit <= 1) hit *= 100;
    hit = Math.max(0, Math.min(100, hit));
  } else {
    hit = null;
  }

  const cost = demo
    ? { known: 1, unknown: 0, total: 0.053 }
    : computeSessionCost(input.transcript_path, input.session_id, cfg);

  let balance = readJson(BALANCE_CACHE);
  if (!demo && !balanceIsFresh(balance, cfg)) spawnBalanceRefresh(cfg);
  if (demo) balance = { at: Date.now(), currency: 'CNY', total: '98.20', available: true };

  const peak = demo ? false : isPeak(new Date(), cfg.holidays);
  const peakLabel = peak ? cfg.labels.peak : cfg.labels.offPeak;
  const peakColor = peak ? C.red : C.green;

  const balanceInfo = fmtBalance(balance, cfg);
  const costText = fmtCost(cost, cfg);

  const sep = cfg.infoSeparator || ' | ';
  const info = [
    `${C.cyan}${model}${C.reset}${C.gray}${sep}ctx ${pct}%${C.reset}`,
    `${C.gray}${hit === null ? '' : `cache ${hit.toFixed(1)}%${sep}`}${cfg.labels.session} ${C.yellow}${costText}${C.reset}`,
    `${balanceInfo.color}${balanceInfo.text}${C.reset}${C.gray}${sep}${C.reset}${peakColor}${peakLabel}${C.reset}`,
  ];

  const columns = Math.max(20, Number(process.env.COLUMNS) || 100);
  const margin = Number(cfg.widthMargin);
  const width = Math.max(10, columns - (Number.isFinite(margin) ? margin : 6));
  const whale = cfg.whale ? whaleLines(cfg) : null;
  const infoWidth = Math.max(...info.map(displayWidth));
  const whaleWidth = whale ? Math.max(...whale.map(displayWidth)) : 0;
  const gap = whale ? width - whaleWidth - infoWidth : 0;

  if (whale && gap >= 2) {
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const left = whale[i] || ' '.repeat(whaleWidth);
      const right = info[i] || '';
      const pad = ' '.repeat(Math.max(0, infoWidth - displayWidth(right)));
      if (cfg.infoAlign === 'right') {
        rows.push(left + ' '.repeat(gap) + pad + right);
      } else {
        rows.push(left + ' '.repeat(gap) + right + pad);
      }
    }
    process.stdout.write(rows.map((row) => '⁠' + row).join('\n') + '\n');
  } else {
    const rows = info.map((line) => {
      const clipped = truncateVisible(line, width);
      return ' '.repeat(Math.max(0, width - displayWidth(clipped))) + clipped;
    });
    process.stdout.write(rows.map((row) => '⁠' + row).join('\n') + '\n');
  }
}

if (require.main === module) {
  if (process.argv.includes('--refresh-balance')) {
    refreshBalanceMode().finally(() => process.exit(0));
  } else {
    main();
  }
}

module.exports = { DEFAULT_CONFIG, isPeak, computeSessionCost, ratesFor, displayWidth };
