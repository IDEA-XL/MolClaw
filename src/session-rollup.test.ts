import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendClosingSummaryToDailyMemory,
  buildClosingSessionSummary,
  loadArchivedSession,
} from './session-rollup.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bioclaw-session-rollup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session rollup', () => {
  it('loads archived session and builds closing summary', () => {
    const root = createTempDir();
    const sessionDir = path.join(
      root,
      'sessions',
      'discord-dm-1',
      '.claude',
      'openai-sessions',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session-1.json'),
      JSON.stringify({
        sessionId: 'session-1',
        createdAt: '2026-03-18T10:00:00.000Z',
        updatedAt: '2026-03-18T10:10:00.000Z',
        rollingSummary: {
          content: 'User was comparing CRBN and IKZF1 papers.',
          tokenCount: 18,
          roundStart: 1,
          roundEnd: 6,
          updatedAt: '2026-03-18T10:09:00.000Z',
        },
        messages: [
          { role: 'user', content: 'Find CRBN papers from 2024.' },
          { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_pubmed' } }] },
          { role: 'tool', name: 'search_pubmed', content: 'Found PMID 123 and 456.' },
          { role: 'assistant', content: 'Here are two relevant papers.' },
        ],
      }, null, 2),
      'utf-8',
    );

    const session = loadArchivedSession(root, 'discord-dm-1', 'session-1');
    expect(session?.sessionId).toBe('session-1');

    const summary = buildClosingSessionSummary(session!);
    expect(summary).not.toBeNull();
    expect(summary?.content).toContain('Rolling summary carried from runtime');
    expect(summary?.content).toContain('Assistant called tools: search_pubmed');
    expect(summary?.toolMessageCount).toBe(1);
  });

  it('appends closing summary to daily memory file', () => {
    const root = createTempDir();
    const dailyPath = appendClosingSummaryToDailyMemory(
      root,
      'discord-dm-1',
      'session-abc',
      {
        title: 'Closing summary',
        content: 'Summary content',
        tokenCount: 12,
        messageCount: 4,
        userMessageCount: 1,
        assistantMessageCount: 2,
        toolMessageCount: 1,
      },
      new Date('2026-03-18T12:00:00.000Z'),
    );

    expect(fs.existsSync(dailyPath)).toBe(true);
    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('Session closing summary: session-abc');
    expect(content).toContain('Summary content');
  });
});
