import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getMemoryEntryById,
  saveMemoryEntry,
  selectMemoryForPrompt,
  searchMemoryEntries,
  type MemoryScopeDescriptor,
} from '../src/memory.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bioclaw-memory-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createScopes(root: string): MemoryScopeDescriptor[] {
  return [
    {
      scope: 'group',
      scopeId: 'discord-dm-123',
      rootDir: path.join(root, 'group'),
      readable: true,
      writable: true,
    },
    {
      scope: 'global',
      scopeId: 'global',
      rootDir: path.join(root, 'global'),
      readable: true,
      writable: false,
    },
  ];
}

describe('memory runtime', () => {
  it('saves entries into MEMORY.md and daily log, then retrieves them by id', () => {
    const scopes = createScopes(createTempDir());
    const saved = saveMemoryEntry(scopes, {
      title: 'CRBN preference',
      content: 'Always include PMID and DOI when summarizing papers.',
      kind: 'preference',
      tags: ['crbn', 'citation'],
      pinned: true,
    });

    expect(fs.existsSync(saved.memoryFilePath)).toBe(true);
    expect(fs.existsSync(saved.dailyLogPath)).toBe(true);

    const entry = getMemoryEntryById(scopes, saved.entry.id);
    expect(entry).not.toBeNull();
    expect(entry?.title).toBe('CRBN preference');
    expect(entry?.tags).toEqual(['crbn', 'citation']);
    expect(entry?.pinned).toBe(true);
  });

  it('searches memory broadly and ranks matching entries', () => {
    const scopes = createScopes(createTempDir());
    const first = saveMemoryEntry(scopes, {
      title: 'CRBN literature workflow',
      content: 'When asked for literature, search PubMed and return PMID plus DOI.',
      kind: 'workflow',
      tags: ['crbn', 'pubmed'],
    });
    saveMemoryEntry(scopes, {
      title: 'General coding preference',
      content: 'Prefer apply_patch for file edits.',
      kind: 'rule',
      tags: ['coding'],
    });

    const results = searchMemoryEntries(scopes, {
      query: 'CRBN DOI PubMed',
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(first.entry.id);
    expect(results[0].title).toContain('CRBN');
  });

  it('uses recent memories as a fallback when prompt keywords do not match', () => {
    const scopes = createScopes(createTempDir());
    const first = saveMemoryEntry(scopes, {
      title: 'Recent workflow',
      content: 'Track AlphaFold paper follow-ups in the current workspace.',
      kind: 'workflow',
    });
    const second = saveMemoryEntry(scopes, {
      title: 'Pinned preference',
      content: 'Always include PMID and DOI.',
      kind: 'preference',
      pinned: true,
    });

    const selection = selectMemoryForPrompt(scopes, {
      query: '',
      maxPinned: 2,
      maxRecent: 2,
      maxMatched: 2,
    });

    expect(selection.matched).toHaveLength(0);
    expect(selection.pinned.map((entry) => entry.id)).toEqual([second.entry.id]);
    expect(selection.recent.map((entry) => entry.id)).toContain(first.entry.id);
  });

  it('rejects writes to non-writable scopes', () => {
    const scopes = createScopes(createTempDir());
    expect(() =>
      saveMemoryEntry(scopes, {
        title: 'Global rule',
        content: 'This should fail from a read-only scope.',
        kind: 'rule',
        scope: 'global',
      }),
    ).toThrow(/not writable/i);
  });
});
