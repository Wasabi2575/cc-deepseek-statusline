#!/usr/bin/env node
'use strict';

/**
 * Remove the deepseek-whale status line.
 *
 *   node scripts/uninstall.js           remove statusLine, keep config
 *   node scripts/uninstall.js --purge   also delete ~/.claude/deepseek-whale
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const TARGET_DIR = path.join(HOME, '.claude', 'deepseek-whale');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const PURGE = process.argv.includes('--purge');

function main() {
  if (!fs.existsSync(SETTINGS)) {
    console.log('No settings.json; nothing to do.');
    return;
  }

  const raw = fs.readFileSync(SETTINGS, 'utf8');
  let settings;
  try {
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`Cannot parse ${SETTINGS}: ${e.message}`);
    process.exit(1);
  }

  const current = settings.statusLine;
  const ours = current && typeof current.command === 'string' && current.command.includes('deepseek-whale');

  if (!ours) {
    console.log('statusLine is not managed by deepseek-whale; leaving it alone.');
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${SETTINGS}.bak.${stamp}`;
    fs.writeFileSync(backup, raw);
    delete settings.statusLine;
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    console.log('Removed statusLine. Backup: ' + backup);
  }

  if (PURGE) {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    console.log('Deleted ' + TARGET_DIR);
  } else {
    console.log('Kept ' + TARGET_DIR + ' (use --purge to delete it).');
  }
}

main();
