import fs from 'fs';
import path from 'path';

interface ArchivedToolCall {
  id?: string;
  function?: {
    name?: string;
  };
}

interface ArchivedChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ArchivedToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ArchivedSessionState {
  sessionId: string;
  messages: ArchivedChatMessage[];
  rollingSummary?: {
    content: string;
    tokenCount: number;
    roundStart: number;
    roundEnd: number;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ClosingSessionSummary {
  title: string;
  content: string;
  tokenCount: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
}

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function sessionFilePath(
  dataDir: string,
  groupFolder: string,
  sessionId: string,
): string {
  return path.join(
    dataDir,
    'sessions',
    groupFolder,
    '.claude',
    'openai-sessions',
    `${sessionId}.json`,
  );
}

export function loadArchivedSession(
  dataDir: string,
  groupFolder: string,
  sessionId: string,
): ArchivedSessionState | null {
  const filePath = sessionFilePath(dataDir, groupFolder, sessionId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ArchivedSessionState;
  } catch {
    return null;
  }
}

function collectMessageLines(
  messages: ArchivedChatMessage[],
  limit: number,
): string[] {
  const selected = messages.slice(-limit);
  const lines: string[] = [];
  for (const message of selected) {
    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'tool') {
      lines.push(
        `- Tool ${message.name || 'unknown'}: ${truncate(message.content || '', 220)}`,
      );
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const tools = message.tool_calls
        .map((toolCall) => toolCall.function?.name)
        .filter((name): name is string => !!name);
      lines.push(`- Assistant called tools: ${tools.join(', ') || 'unknown'}`);
      continue;
    }

    const prefix = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`- ${prefix}: ${truncate(message.content || '', 260)}`);
  }
  return lines;
}

export function buildClosingSessionSummary(
  session: ArchivedSessionState,
): ClosingSessionSummary | null {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (messages.length === 0 && !session.rollingSummary?.content) {
    return null;
  }

  const userMessageCount = messages.filter((message) => message.role === 'user').length;
  const assistantMessageCount = messages.filter((message) => message.role === 'assistant').length;
  const toolMessageCount = messages.filter((message) => message.role === 'tool').length;
  const recentLines = collectMessageLines(messages, 10);

  const blocks = [
    `Session ${session.sessionId} closed at ${session.updatedAt}.`,
    `Message stats: user=${userMessageCount}, assistant=${assistantMessageCount}, tool=${toolMessageCount}.`,
    session.rollingSummary?.content
      ? `Rolling summary carried from runtime:\n${session.rollingSummary.content}`
      : null,
    recentLines.length > 0
      ? `Recent tail at close:\n${recentLines.join('\n')}`
      : null,
  ].filter((block): block is string => !!block);

  const content = truncate(blocks.join('\n\n'), 12_000);
  return {
    title: `Closing summary for ${session.sessionId}`,
    content,
    tokenCount: estimateTokenCount(content),
    messageCount: messages.length,
    userMessageCount,
    assistantMessageCount,
    toolMessageCount,
  };
}

export function appendClosingSummaryToDailyMemory(
  groupsDir: string,
  groupFolder: string,
  sessionId: string,
  summary: ClosingSessionSummary,
  ts = new Date(),
): string {
  const memoryDir = path.join(groupsDir, groupFolder, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const dailyPath = path.join(memoryDir, `${ts.toISOString().slice(0, 10)}.md`);

  if (!fs.existsSync(dailyPath)) {
    fs.writeFileSync(
      dailyPath,
      `# Memory Log ${ts.toISOString().slice(0, 10)}\n\n`,
      'utf-8',
    );
  }

  const lines = [
    `## Session closing summary: ${sessionId}`,
    '',
    `- type: closing_summary`,
    `- session_id: ${sessionId}`,
    `- token_count: ${summary.tokenCount}`,
    `- message_count: ${summary.messageCount}`,
    `- user_messages: ${summary.userMessageCount}`,
    `- assistant_messages: ${summary.assistantMessageCount}`,
    `- tool_messages: ${summary.toolMessageCount}`,
    `- saved_at: ${ts.toISOString()}`,
    '',
    summary.content,
    '',
  ];

  fs.appendFileSync(dailyPath, `${lines.join('\n')}\n`, 'utf-8');
  return dailyPath;
}
