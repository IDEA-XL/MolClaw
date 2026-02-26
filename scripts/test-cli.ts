/**
 * Non-interactive CLI test: sends a single prompt to BioClaw container and prints output.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  GROUPS_DIR,
  DATA_DIR,
} from '../src/config.js';

const GROUP_FOLDER = 'cli-test';

function ensureDirs() {
  const dirs = [
    path.join(GROUPS_DIR, GROUP_FOLDER, 'logs'),
    path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude'),
    path.join(DATA_DIR, 'ipc', GROUP_FOLDER, 'messages'),
    path.join(DATA_DIR, 'ipc', GROUP_FOLDER, 'tasks'),
    path.join(DATA_DIR, 'ipc', GROUP_FOLDER, 'input'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readSecrets(): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return {};
  const secrets: Record<string, string> = {};
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key) && value) {
      secrets[key] = value;
    }
  }
  return secrets;
}

async function main() {
  const prompt = process.argv[2] || 'Use BioPython to translate DNA sequence ATGGAGGAGCCGCAGTCAGATCCTAGCG to protein and calculate its GC content. Write a python script, run it, and show the output.';

  console.log(`\n[BioClaw CLI Test]`);
  console.log(`Prompt: ${prompt}\n`);

  ensureDirs();

  const projectRoot = process.cwd();
  const groupDir = path.join(GROUPS_DIR, GROUP_FOLDER);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const sessionsDir = path.join(DATA_DIR, 'sessions', GROUP_FOLDER, '.claude');
  const ipcDir = path.join(DATA_DIR, 'ipc', GROUP_FOLDER);
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');

  const secrets = readSecrets();
  console.log(`API Key loaded: ${secrets.ANTHROPIC_API_KEY ? 'YES (' + secrets.ANTHROPIC_API_KEY.slice(0, 12) + '...)' : 'NO'}`);

  const input = {
    prompt,
    groupFolder: GROUP_FOLDER,
    chatJid: 'cli@local',
    isMain: false,
    secrets,
  };

  const args = [
    'run', '-i', '--rm',
    '-v', `${groupDir}:/workspace/group`,
    '-v', `${globalDir}:/workspace/global:ro`,
    '-v', `${sessionsDir}:/home/node/.claude`,
    '-v', `${ipcDir}:/workspace/ipc`,
    '-v', `${agentRunnerSrc}:/app/src:ro`,
    CONTAINER_IMAGE,
  ];

  console.log(`Docker command: docker ${args.join(' ')}\n`);
  console.log('--- Waiting for agent response (up to 3 min) ---\n');

  const container = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let resultFound = false;

  container.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    process.stdout.write(chunk);

    const startMarker = '---BIOCLAW_OUTPUT_START---';
    const endMarker = '---BIOCLAW_OUTPUT_END---';
    let startIdx: number;
    while ((startIdx = stdout.indexOf(startMarker)) !== -1) {
      const endIdx = stdout.indexOf(endMarker, startIdx);
      if (endIdx === -1) break;
      const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();
      stdout = stdout.slice(endIdx + endMarker.length);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.result) {
          resultFound = true;
          const text = parsed.result.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          console.log(`\n=== ${ASSISTANT_NAME} Response ===`);
          console.log(text);
          console.log('=== End ===\n');
        }
      } catch { /* ignore */ }
    }
  });

  container.stderr.on('data', (data: Buffer) => {
    process.stderr.write(data.toString());
  });

  container.stdin.write(JSON.stringify(input));
  container.stdin.end();

  const killTimer = setTimeout(() => {
    console.log('\n[Timeout reached - killing container]');
    container.kill('SIGKILL');
  }, 180000);

  container.on('close', (code: number | null) => {
    clearTimeout(killTimer);
    console.log(`\nContainer exited with code ${code}`);
    if (!resultFound) {
      console.log('No BIOCLAW_OUTPUT markers found in stdout.');
      console.log('Raw stdout tail:', stdout.slice(-500));
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
