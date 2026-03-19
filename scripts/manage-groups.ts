#!/usr/bin/env npx tsx
/**
 * MolClaw Group Management CLI
 *
 * Usage:
 *   npx tsx scripts/manage-groups.ts list          — Show registered groups
 *   npx tsx scripts/manage-groups.ts available      — Show all discovered WhatsApp groups
 *   npx tsx scripts/manage-groups.ts register       — Interactive: register a new group
 *   npx tsx scripts/manage-groups.ts remove <jid>   — Remove a registered group
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

const STORE_DIR = path.join(import.meta.dirname, '..', 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  console.error('Make sure MolClaw has been started at least once.');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: false });

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function listRegistered() {
  const rows = db.prepare('SELECT * FROM registered_groups ORDER BY added_at DESC').all() as any[];
  if (rows.length === 0) {
    console.log('\nNo registered groups. Use "register" to add one.\n');
    return;
  }
  console.log(`\n=== Registered Groups (${rows.length}) ===\n`);
  for (const r of rows) {
    const trigger = r.requires_trigger ? `trigger: ${r.trigger_pattern}` : 'no trigger needed';
    console.log(`  ${r.name}`);
    console.log(`    JID:     ${r.jid}`);
    console.log(`    Folder:  ${r.folder}`);
    console.log(`    Mode:    ${trigger}`);
    console.log(`    Added:   ${r.added_at}`);
    console.log();
  }
}

function listAvailable() {
  const registered = new Set(
    (db.prepare('SELECT jid FROM registered_groups').all() as any[]).map((r) => r.jid),
  );
  const chats = db
    .prepare("SELECT jid, name, last_message_time FROM chats WHERE jid LIKE '%@g.us' ORDER BY last_message_time DESC")
    .all() as any[];

  if (chats.length === 0) {
    console.log('\nNo WhatsApp groups discovered yet. Send a message in a group first.\n');
    return;
  }

  console.log(`\n=== Available WhatsApp Groups (${chats.length}) ===\n`);
  for (let i = 0; i < chats.length; i++) {
    const c = chats[i];
    const status = registered.has(c.jid) ? ' [REGISTERED]' : '';
    console.log(`  ${i + 1}. ${c.name || '(unnamed)'}${status}`);
    console.log(`     JID:  ${c.jid}`);
    console.log(`     Last: ${c.last_message_time || 'N/A'}`);
    console.log();
  }
}

async function registerGroup() {
  const registered = new Set(
    (db.prepare('SELECT jid FROM registered_groups').all() as any[]).map((r) => r.jid),
  );
  const chats = db
    .prepare("SELECT jid, name, last_message_time FROM chats WHERE jid LIKE '%@g.us' ORDER BY last_message_time DESC")
    .all() as any[];

  const unregistered = chats.filter((c) => !registered.has(c.jid));
  if (unregistered.length === 0) {
    console.log('\nAll discovered groups are already registered (or no groups discovered).\n');
    return;
  }

  console.log('\n=== Unregistered Groups ===\n');
  for (let i = 0; i < unregistered.length; i++) {
    console.log(`  ${i + 1}. ${unregistered[i].name || '(unnamed)'}  —  ${unregistered[i].jid}`);
  }

  const choice = await prompt(`\nSelect group number (1-${unregistered.length}): `);
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= unregistered.length) {
    console.log('Invalid selection.');
    return;
  }

  const selected = unregistered[idx];
  const defaultName = selected.name || 'unnamed-group';
  const defaultFolder = defaultName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const name = (await prompt(`Group display name [${defaultName}]: `)) || defaultName;
  const folder = (await prompt(`Folder name [${defaultFolder}]: `)) || defaultFolder;
  const triggerInput = await prompt('Trigger pattern [@MolClaw]: ');
  const trigger = triggerInput || '@MolClaw';
  const reqTrigger = (await prompt('Require trigger? (y/n) [y]: ')) || 'y';

  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(selected.jid, name, folder, trigger, new Date().toISOString(), reqTrigger.toLowerCase() === 'y' ? 1 : 0);

  // Create group folder
  const groupDir = path.join(import.meta.dirname, '..', 'groups', folder);
  fs.mkdirSync(groupDir, { recursive: true });

  console.log(`\nRegistered "${name}" (${selected.jid}) -> folder: ${folder}`);
  console.log('Restart MolClaw for the change to take effect.\n');
}

function removeGroup(jid: string) {
  const row = db.prepare('SELECT name FROM registered_groups WHERE jid = ?').get(jid) as any;
  if (!row) {
    console.log(`\nGroup ${jid} is not registered.\n`);
    return;
  }
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
  console.log(`\nRemoved "${row.name}" (${jid}). Restart MolClaw for the change to take effect.\n`);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'list':
    listRegistered();
    break;
  case 'available':
    listAvailable();
    break;
  case 'register':
    await registerGroup();
    break;
  case 'remove':
    if (!args[0]) {
      console.log('Usage: manage-groups.ts remove <jid>');
    } else {
      removeGroup(args[0]);
    }
    break;
  default:
    console.log(`
MolClaw Group Management

Commands:
  list        Show registered groups (bot will reply here)
  available   Show all discovered WhatsApp groups
  register    Interactive: register a new group
  remove      Remove a group by JID

Examples:
  npx tsx scripts/manage-groups.ts list
  npx tsx scripts/manage-groups.ts available
  npx tsx scripts/manage-groups.ts register
  npx tsx scripts/manage-groups.ts remove "120363xxx@g.us"
`);
}

db.close();
