import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export type MemoryScopeName = 'group' | 'global' | 'project';
export type MemorySearchScope = MemoryScopeName | 'all';

export interface MemoryScopeDescriptor {
  scope: MemoryScopeName;
  scopeId: string;
  rootDir: string;
  readable: boolean;
  writable: boolean;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScopeName;
  scopeId: string;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  filePath: string;
}

export interface SaveMemoryInput {
  title: string;
  content: string;
  kind: string;
  scope?: MemoryScopeName;
  tags?: string[];
  pinned?: boolean;
  source?: string;
}

export interface SavedMemoryResult {
  entry: MemoryEntry;
  memoryFilePath: string;
  dailyLogPath: string;
}

export interface MemorySearchResult {
  id: string;
  title: string;
  kind: string;
  scope: MemoryScopeName;
  scopeId: string;
  score: number;
  shortPreview: string;
  pinned: boolean;
  updatedAt: string;
}

export interface SelectedMemoryContext {
  pinned: MemoryEntry[];
  recent: MemoryEntry[];
  matched: MemoryEntry[];
}

interface ParsedMemoryMetadata {
  id: string;
  scope: MemoryScopeName;
  scopeId: string;
  kind: string;
  title: string;
  tags?: string[];
  source?: string;
  pinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

const MEMORY_ENTRY_START = '<!-- BIOCLAW_MEMORY_ENTRY_START ';
const MEMORY_ENTRY_END = '<!-- BIOCLAW_MEMORY_ENTRY_END -->';
const MEMORY_HEADER = `# BioClaw Memory

This file stores durable memory entries for this scope.
Entries are human-readable Markdown with machine-readable metadata comments.
`;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function sanitizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  return unique(
    tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  );
}

function formatHeading(title: string): string {
  return `## ${title.trim()}`;
}

function buildMemoryFilePath(rootDir: string): string {
  return path.join(rootDir, 'MEMORY.md');
}

function buildDailyLogPath(rootDir: string, now: Date): string {
  return path.join(rootDir, 'memory', `${now.toISOString().slice(0, 10)}.md`);
}

function ensureMemoryFiles(rootDir: string, now: Date): {
  memoryFilePath: string;
  dailyLogPath: string;
} {
  fs.mkdirSync(rootDir, { recursive: true });
  const memoryFilePath = buildMemoryFilePath(rootDir);
  if (!fs.existsSync(memoryFilePath)) {
    fs.writeFileSync(memoryFilePath, `${MEMORY_HEADER}\n`, 'utf-8');
  }

  const dailyDir = path.join(rootDir, 'memory');
  fs.mkdirSync(dailyDir, { recursive: true });
  const dailyLogPath = buildDailyLogPath(rootDir, now);
  if (!fs.existsSync(dailyLogPath)) {
    fs.writeFileSync(
      dailyLogPath,
      `# Memory Log ${now.toISOString().slice(0, 10)}\n\n`,
      'utf-8',
    );
  }

  return { memoryFilePath, dailyLogPath };
}

function stripGeneratedHeading(body: string, title: string): string {
  const normalized = body.trim();
  const heading = formatHeading(title);
  if (!normalized.startsWith(heading)) {
    return normalized;
  }

  const remainder = normalized.slice(heading.length);
  return remainder.replace(/^\s+/, '').trim();
}

function formatMemoryBlock(entry: Omit<MemoryEntry, 'filePath'>): string {
  const metadata = JSON.stringify({
    id: entry.id,
    scope: entry.scope,
    scopeId: entry.scopeId,
    kind: entry.kind,
    title: entry.title,
    tags: entry.tags,
    source: entry.source,
    pinned: entry.pinned,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });

  return [
    `${MEMORY_ENTRY_START}${metadata} -->`,
    formatHeading(entry.title),
    '',
    entry.content.trim(),
    MEMORY_ENTRY_END,
    '',
  ].join('\n');
}

function appendDailyLog(
  dailyLogPath: string,
  entry: Omit<MemoryEntry, 'filePath'>,
): void {
  const lines = [
    `## ${entry.title}`,
    '',
    `- id: ${entry.id}`,
    `- scope: ${entry.scope} (${entry.scopeId})`,
    `- kind: ${entry.kind}`,
    `- pinned: ${entry.pinned ? 'yes' : 'no'}`,
    `- source: ${entry.source}`,
    `- saved_at: ${entry.updatedAt}`,
    entry.tags.length > 0 ? `- tags: ${entry.tags.join(', ')}` : null,
    '',
    entry.content.trim(),
    '',
  ].filter((line): line is string => line !== null);

  fs.appendFileSync(dailyLogPath, `${lines.join('\n')}\n`, 'utf-8');
}

function parseMemoryEntriesFromFile(
  filePath: string,
  fallbackScope: MemoryScopeName,
  fallbackScopeId: string,
): MemoryEntry[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const pattern = /<!-- BIOCLAW_MEMORY_ENTRY_START ([\s\S]*?) -->\n([\s\S]*?)\n<!-- BIOCLAW_MEMORY_ENTRY_END -->/g;
  const entries: MemoryEntry[] = [];

  for (const match of content.matchAll(pattern)) {
    let metadata: ParsedMemoryMetadata;
    try {
      metadata = JSON.parse(match[1]) as ParsedMemoryMetadata;
    } catch {
      continue;
    }

    const title = typeof metadata.title === 'string' && metadata.title.trim()
      ? metadata.title.trim()
      : 'Untitled memory';
    const body = stripGeneratedHeading(match[2], title);
    entries.push({
      id: metadata.id,
      scope: metadata.scope || fallbackScope,
      scopeId: metadata.scopeId || fallbackScopeId,
      kind: metadata.kind || 'fact',
      title,
      content: body,
      tags: sanitizeTags(metadata.tags),
      source: metadata.source?.trim() || 'tool',
      pinned: metadata.pinned === true,
      createdAt: metadata.createdAt || new Date(0).toISOString(),
      updatedAt: metadata.updatedAt || metadata.createdAt || new Date(0).toISOString(),
      filePath,
    });
  }

  return entries;
}

export function listMemoryEntries(
  scopes: MemoryScopeDescriptor[],
  requestedScope: MemorySearchScope = 'all',
): MemoryEntry[] {
  const selectedScopes = selectScopes(scopes, requestedScope, false);
  return selectedScopes.flatMap((scope) =>
    parseMemoryEntriesFromFile(
      buildMemoryFilePath(scope.rootDir),
      scope.scope,
      scope.scopeId,
    ),
  );
}

function tokenizeQuery(query: string): string[] {
  return unique(
    query
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );
}

function scoreEntry(entry: MemoryEntry, query: string, tokens: string[]): number {
  const title = entry.title.toLowerCase();
  const content = entry.content.toLowerCase();
  const kind = entry.kind.toLowerCase();
  const tags = entry.tags.map((tag) => tag.toLowerCase());
  let score = 0;

  if (title === query) {
    score += 10;
  } else if (title.includes(query)) {
    score += 7;
  }

  if (content.includes(query)) {
    score += 3;
  }
  if (kind.includes(query)) {
    score += 2;
  }

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 3;
    }
    if (content.includes(token)) {
      score += 1;
    }
    if (tags.some((tag) => tag.includes(token))) {
      score += 2;
    }
    if (kind.includes(token)) {
      score += 1;
    }
  }

  if (entry.pinned) {
    score += 0.5;
  }

  return score;
}

function previewContent(content: string, maxChars = 220): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function selectScopes(
  scopes: MemoryScopeDescriptor[],
  requestedScope: MemorySearchScope,
  requireWritable: boolean,
): MemoryScopeDescriptor[] {
  const filtered = scopes.filter((scope) =>
    requestedScope === 'all' ? true : scope.scope === requestedScope,
  );
  return filtered.filter((scope) => (requireWritable ? scope.writable : scope.readable));
}

export function buildDefaultMemoryScopes(options: {
  groupFolder: string;
  readableRoots: string[];
  writableRoots: string[];
}): MemoryScopeDescriptor[] {
  const readable = new Set(options.readableRoots.map((root) => path.resolve(root)));
  const writable = new Set(options.writableRoots.map((root) => path.resolve(root)));

  const descriptors: MemoryScopeDescriptor[] = [
    {
      scope: 'group',
      scopeId: options.groupFolder,
      rootDir: '/workspace/group',
      readable: readable.has(path.resolve('/workspace/group')),
      writable: writable.has(path.resolve('/workspace/group')),
    },
    {
      scope: 'global',
      scopeId: 'global',
      rootDir: '/workspace/global',
      readable: readable.has(path.resolve('/workspace/global')),
      writable: writable.has(path.resolve('/workspace/global')),
    },
    {
      scope: 'project',
      scopeId: 'project',
      rootDir: '/workspace/project',
      readable: readable.has(path.resolve('/workspace/project')),
      writable: writable.has(path.resolve('/workspace/project')),
    },
  ];

  return descriptors.filter((scope) => scope.readable || scope.writable);
}

export function saveMemoryEntry(
  scopes: MemoryScopeDescriptor[],
  input: SaveMemoryInput,
): SavedMemoryResult {
  const targetScope = input.scope || 'group';
  const [scope] = selectScopes(scopes, targetScope, true);
  if (!scope) {
    throw new Error(`Memory scope is not writable: ${targetScope}`);
  }

  const now = new Date();
  const timestamp = now.toISOString();
  const { memoryFilePath, dailyLogPath } = ensureMemoryFiles(scope.rootDir, now);
  const entryWithoutFile = {
    id: `mem_${now.toISOString().replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}`,
    scope: scope.scope,
    scopeId: scope.scopeId,
    kind: input.kind.trim(),
    title: input.title.trim(),
    content: normalizeWhitespace(input.content).trim(),
    tags: sanitizeTags(input.tags),
    source: input.source?.trim() || 'tool',
    pinned: input.pinned === true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  fs.appendFileSync(memoryFilePath, `${formatMemoryBlock(entryWithoutFile)}\n`, 'utf-8');
  appendDailyLog(dailyLogPath, entryWithoutFile);

  return {
    entry: {
      ...entryWithoutFile,
      filePath: memoryFilePath,
    },
    memoryFilePath,
    dailyLogPath,
  };
}

export function searchMemoryEntries(
  scopes: MemoryScopeDescriptor[],
  options: {
    query: string;
    scope?: MemorySearchScope;
    limit?: number;
  },
): MemorySearchResult[] {
  const requestedScope = options.scope || 'all';
  const selectedScopes = selectScopes(scopes, requestedScope, false);
  const normalizedQuery = options.query.trim().toLowerCase();
  const tokens = tokenizeQuery(normalizedQuery);
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)));
  if (!normalizedQuery && tokens.length === 0) {
    return [];
  }
  const entries = listMemoryEntries(selectedScopes, 'all');

  return entries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, normalizedQuery, tokens),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
    })
    .slice(0, limit)
    .map(({ entry, score }) => ({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      scope: entry.scope,
      scopeId: entry.scopeId,
      score,
      shortPreview: previewContent(entry.content),
      pinned: entry.pinned,
      updatedAt: entry.updatedAt,
    }));
}

export function getMemoryEntryById(
  scopes: MemoryScopeDescriptor[],
  id: string,
): MemoryEntry | null {
  const selectedScopes = scopes.filter((scope) => scope.readable);
  for (const scope of selectedScopes) {
    const entries = parseMemoryEntriesFromFile(
      buildMemoryFilePath(scope.rootDir),
      scope.scope,
      scope.scopeId,
    );
    const match = entries.find((entry) => entry.id === id);
    if (match) {
      return match;
    }
  }
  return null;
}

export function selectMemoryForPrompt(
  scopes: MemoryScopeDescriptor[],
  options: {
    query: string;
    maxPinned?: number;
    maxRecent?: number;
    maxMatched?: number;
  },
): SelectedMemoryContext {
  const allEntries = listMemoryEntries(scopes, 'all');
  const maxPinned = Math.max(0, Math.min(8, Math.floor(options.maxPinned ?? 4)));
  const maxRecent = Math.max(0, Math.min(8, Math.floor(options.maxRecent ?? 3)));
  const maxMatched = Math.max(0, Math.min(8, Math.floor(options.maxMatched ?? 4)));
  const pinned = allEntries
    .filter((entry) => entry.pinned)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxPinned);

  const matchedIds = new Set(pinned.map((entry) => entry.id));
  const matched = searchMemoryEntries(scopes, {
    query: options.query,
    scope: 'all',
    limit: maxMatched + pinned.length,
  })
    .map((result) => getMemoryEntryById(scopes, result.id))
    .filter((entry): entry is MemoryEntry => !!entry && !matchedIds.has(entry.id))
    .slice(0, maxMatched);

  const selectedIds = new Set([
    ...pinned.map((entry) => entry.id),
    ...matched.map((entry) => entry.id),
  ]);
  const recent = allEntries
    .filter((entry) => !selectedIds.has(entry.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxRecent);

  return { pinned, recent, matched };
}

export function renderMemoryContextBlock(
  label: string,
  entries: MemoryEntry[],
): string | null {
  if (entries.length === 0) {
    return null;
  }

  const renderedEntries = entries.map((entry) => [
    `- id: ${entry.id}`,
    `  title: ${entry.title}`,
    `  scope: ${entry.scope} (${entry.scopeId})`,
    `  kind: ${entry.kind}`,
    entry.tags.length > 0 ? `  tags: ${entry.tags.join(', ')}` : null,
    `  updated_at: ${entry.updatedAt}`,
    `  content: ${previewContent(entry.content, 500)}`,
  ].filter((line): line is string => line !== null).join('\n'));

  return [
    `<${label}>`,
    ...renderedEntries,
    `</${label}>`,
  ].join('\n');
}
