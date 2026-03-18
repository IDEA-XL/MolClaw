import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  clearSession,
  createMemoryEntry,
  createSessionSummary,
  createTask,
  deleteTask,
  getAllChats,
  getMemoryEntry,
  getMemoryEntryByExternalId,
  getMemoryHits,
  getRecentMessages,
  getMessagesSince,
  getNewMessages,
  getSession,
  getSessionSummaries,
  listMemoryEntries,
  recordMemoryHit,
  upsertMemoryEntryByExternalId,
  setSession,
  getTaskById,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('stores empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    const msgs = [
      { id: 'm1', content: 'first', ts: '2024-01-01T00:00:01.000Z', sender: 'Alice' },
      { id: 'm2', content: 'second', ts: '2024-01-01T00:00:02.000Z', sender: 'Bob' },
      { id: 'm3', content: 'Bio: bot reply', ts: '2024-01-01T00:00:03.000Z', sender: 'Bot' },
      { id: 'm4', content: 'third', ts: '2024-01-01T00:00:04.000Z', sender: 'Carol' },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: 'group@g.us',
        sender: `${m.sender}@s.whatsapp.net`,
        sender_name: m.sender,
        content: m.content,
        timestamp: m.ts,
      });
    }
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:02.000Z', 'Bio');
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes messages from the assistant (content prefix)', () => {
    const msgs = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Bio');
    const botMsgs = msgs.filter((m) => m.content.startsWith('Bio:'));
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Bio');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    const msgs = [
      { id: 'a1', chat: 'group1@g.us', content: 'g1 msg1', ts: '2024-01-01T00:00:01.000Z' },
      { id: 'a2', chat: 'group2@g.us', content: 'g2 msg1', ts: '2024-01-01T00:00:02.000Z' },
      { id: 'a3', chat: 'group1@g.us', content: 'Bio: reply', ts: '2024-01-01T00:00:03.000Z' },
      { id: 'a4', chat: 'group1@g.us', content: 'g1 msg2', ts: '2024-01-01T00:00:04.000Z' },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: m.chat,
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: m.content,
        timestamp: m.ts,
      });
    }
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Bio',
    );
    // Excludes 'Bio: reply', returns 3 messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Bio',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Bio');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- getRecentMessages ---

describe('getRecentMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const msgs = [
      { id: 'r1', content: 'one', ts: '2024-01-01T00:00:01.000Z' },
      { id: 'r2', content: 'Bio: internal reply', ts: '2024-01-01T00:00:02.000Z' },
      { id: 'r3', content: 'three', ts: '2024-01-01T00:00:03.000Z' },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: m.content,
        timestamp: m.ts,
      });
    }
  });

  it('returns messages in ascending time order and applies limit', () => {
    const messages = getRecentMessages('group@g.us', 2, 'Bio');
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('r1');
    expect(messages[1].id).toBe('r3');
  });

  it('returns all message types when botPrefix is omitted', () => {
    const messages = getRecentMessages('group@g.us', 10);
    expect(messages).toHaveLength(3);
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

describe('session accessors', () => {
  it('sets, reads, and clears a session by group folder', () => {
    expect(getSession('group-a')).toBeUndefined();
    setSession('group-a', 'session-123');
    expect(getSession('group-a')).toBe('session-123');
    clearSession('group-a');
    expect(getSession('group-a')).toBeUndefined();
  });
});

describe('memory persistence', () => {
  it('creates and lists memory entries with typed fields', () => {
    const memoryId = createMemoryEntry({
      externalId: 'mem-crbn-focus',
      scope: 'group',
      scopeId: 'discord-dm-1',
      kind: 'fact',
      title: 'CRBN focus',
      content: 'User is tracking CRBN papers from 2024 onward.',
      tags: ['crbn', 'pubmed'],
      source: 'tool',
      pinned: true,
    });

    const created = getMemoryEntry(memoryId);
    expect(created?.scope).toBe('group');
    expect(created?.externalId).toBe('mem-crbn-focus');
    expect(created?.scopeId).toBe('discord-dm-1');
    expect(created?.title).toBe('CRBN focus');
    expect(created?.tags).toEqual(['crbn', 'pubmed']);
    expect(created?.pinned).toBe(true);
    expect(created?.hitCount).toBe(0);

    createMemoryEntry({
      scope: 'group',
      scopeId: 'discord-dm-1',
      kind: 'summary',
      content: 'Older archived memory.',
      source: 'session_rollup',
      archived: true,
    });

    const activeEntries = listMemoryEntries({
      scope: 'group',
      scopeId: 'discord-dm-1',
    });
    expect(activeEntries).toHaveLength(1);
    expect(activeEntries[0].id).toBe(memoryId);

    const allEntries = listMemoryEntries({
      scope: 'group',
      scopeId: 'discord-dm-1',
      includeArchived: true,
    });
    expect(allEntries).toHaveLength(2);
  });

  it('records memory hits and updates access counters', () => {
    const memoryId = createMemoryEntry({
      scope: 'group',
      scopeId: 'discord-dm-2',
      kind: 'preference',
      title: 'Citation preference',
      content: 'Always include PMID and DOI.',
      source: 'manual',
    });

    recordMemoryHit({
      chatJid: 'dc:123',
      groupFolder: 'discord-dm-2',
      sessionId: 'session-1',
      round: 3,
      memoryEntryId: memoryId,
      injectionLayer: 'durable',
      reason: 'matched keywords',
      tokenCount: 48,
    });

    const memory = getMemoryEntry(memoryId);
    expect(memory?.hitCount).toBe(1);
    expect(memory?.lastAccessedAt).toBeTruthy();

    const hits = getMemoryHits({ chatJid: 'dc:123' });
    expect(hits).toHaveLength(1);
    expect(hits[0].memoryEntryId).toBe(memoryId);
    expect(hits[0].memoryTitle).toBe('Citation preference');
    expect(hits[0].memoryKind).toBe('preference');
    expect(hits[0].round).toBe(3);
    expect(hits[0].injectionLayer).toBe('durable');
  });

  it('upserts by external id for container-synced memory records', () => {
    const firstId = upsertMemoryEntryByExternalId({
      externalId: 'mem-1',
      scope: 'group',
      scopeId: 'discord-dm-3',
      kind: 'fact',
      title: 'Initial title',
      content: 'Initial content',
      source: 'tool',
      tags: ['one'],
    });

    const secondId = upsertMemoryEntryByExternalId({
      externalId: 'mem-1',
      scope: 'group',
      scopeId: 'discord-dm-3',
      kind: 'fact',
      title: 'Updated title',
      content: 'Updated content',
      source: 'tool',
      tags: ['two'],
      pinned: true,
    });

    expect(secondId).toBe(firstId);

    const updated = getMemoryEntryByExternalId('mem-1');
    expect(updated?.title).toBe('Updated title');
    expect(updated?.content).toBe('Updated content');
    expect(updated?.tags).toEqual(['two']);
    expect(updated?.pinned).toBe(true);
  });
});

describe('session summaries', () => {
  it('stores and retrieves session summary snapshots', () => {
    createSessionSummary({
      sessionId: 'session-a',
      groupFolder: 'discord-dm-1',
      chatJid: 'dc:abc',
      summaryType: 'rolling',
      content: 'The user is comparing CRBN degraders.',
      tokenCount: 212,
      roundStart: 1,
      roundEnd: 8,
    });

    createSessionSummary({
      sessionId: 'session-a',
      groupFolder: 'discord-dm-1',
      chatJid: 'dc:abc',
      summaryType: 'closing',
      content: 'Session closed with follow-up items.',
      tokenCount: 128,
      roundStart: 1,
      roundEnd: 10,
    });

    const summaries = getSessionSummaries({ sessionId: 'session-a' });
    expect(summaries).toHaveLength(2);
    expect(summaries[0].summaryType).toBe('closing');
    expect(summaries[1].summaryType).toBe('rolling');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});
