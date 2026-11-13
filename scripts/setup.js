#!/usr/bin/env node
'use strict';

/**
 * Install the deepseek-whale status line.
 *
 *   node scripts/setup.js            install / update
 *   node scripts/setup.js --dry-run  print the change without writing
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_CONFIG } = require('./statusline.js');

const HOME = os.homedir();
const TARGET_DIR = path.join(HOME, '.claude', 'deepseek-whale');
const TARGET_SCRIPT = path.join(TARGET_DIR, 'statusline.js');
const TARGET_CONFIG = path.join(TARGET_DIR, 'config.json');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const DRY = process.argv.includes('--dry-run');

function slash(p) {
  return p.replace(/\\/g, '/');
}

function backupSettings(raw) {
  if (DRY) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${SETTINGS}.bak.${stamp}`;
  fs.writeFileSync(backup, raw);
  return backup;
}

function main() {
  const sourceScript = path.join(__dirname, 'statusline.js');
  const sourceConfig = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';

  let settings = {};
  let rawSettings = null;

  if (fs.existsSync(SETTINGS)) {
    rawSettings = fs.readFileSync(SETTINGS, 'utf8');
    try {
      settings = rawSettings.trim() ? JSON.parse(rawSettings) : {};
    } catch (e) {
      console.error(`Cannot parse ${SETTINGS}: ${e.message}`);
      console.error('Fix the JSON first; nothing was changed.');
      process.exit(1);
    }
  }

  const nodePath = slash(process.execPath);
  const scriptPath = slash(TARGET_SCRIPT);
  const command = `"${nodePath}" "${scriptPath}"`;

  const entry = {
    type: 'command',
    command,
    padding: 0,
    refreshInterval: 30,
  };

  if (DRY) {
    console.log('Would copy:', sourceScript, '->', TARGET_SCRIPT);
    console.log('Would write config if missing:', TARGET_CONFIG);
    console.log('Would set statusLine:', JSON.stringify(entry, null, 2));
    return;
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.copyFileSync(sourceScript, TARGET_SCRIPT);
  if (!fs.existsSync(TARGET_CONFIG)) {
    fs.writeFileSync(TARGET_CONFIG, sourceConfig);
  }

  const backup = rawSettings !== null ? backupSettings(rawSettings) : null;
  const previous = settings.statusLine;

  settings.statusLine = entry;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

  console.log('deepseek-whale installed.');
  console.log('');
  console.log('  statusLine command : ' + command);
  console.log('  config            : ' + TARGET_CONFIG);
  if (backup) console.log('  settings backup   : ' + backup);
  if (previous) console.log('  replaced previous : ' + JSON.stringify(previous));
  console.log('');
  console.log('Balance uses DEEPSEEK_API_KEY, or ANTHROPIC_AUTH_TOKEN when');
  console.log('ANTHROPIC_BASE_URL points at api.deepseek.com.');
  console.log('');
  console.log('If the whale does not appear immediately, restart Claude Code.');
}

main();
