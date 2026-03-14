/**
 * BioClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * This runner talks to an OpenAI-compatible `/chat/completions` endpoint and
 * implements a small tool runtime directly, so BioClaw can work with gateway
 * providers instead of Anthropic's SDK.
 */

import { exec as execCallback } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  progress?: AgentProgressEvent;
}

interface AgentProgressEvent {
  type: 'lifecycle' | 'provider' | 'tool';
  stage: 'start' | 'end' | 'info' | 'error';
  message?: string;
  round?: number;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  argsSummary?: string;
  durationMs?: number;
  success?: boolean;
  contentChars?: number;
  toolCalls?: number;
  timestamp: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface SessionState {
  sessionId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: ToolCall[];
    };
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

interface ProviderConfig {
  apiKey?: string;
  apiUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  thinkingType?: string;
}

interface ToolContext {
  containerInput: ContainerInput;
  readableRoots: string[];
  writableRoots: string[];
}

interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

interface PubMedSearchResponse {
  esearchresult?: {
    count?: string;
    idlist?: string[];
  };
}

interface PubMedArticleId {
  idtype?: string;
  value?: string;
}

interface PubMedSummaryItem {
  uid?: string;
  title?: string;
  pubdate?: string;
  sortpubdate?: string;
  fulljournalname?: string;
  source?: string;
  authors?: Array<{
    name?: string;
  }>;
  articleids?: PubMedArticleId[];
}

interface PubMedSummaryResponse {
  result?: {
    uids?: string[];
    [uid: string]: PubMedSummaryItem[] | PubMedSummaryItem | string[] | undefined;
  };
}

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

const exec = promisify(execCallback);

const OUTPUT_START_MARKER = '---BIOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---BIOCLAW_OUTPUT_END---';

const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const FILES_DIR = path.join(IPC_DIR, 'files');
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const SESSION_DIR = '/home/node/.claude/openai-sessions';
const CONVERSATIONS_DIR = '/workspace/group/conversations';
const MAX_TOOL_ROUNDS = 24;
const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_FILE_READ_CHARS = 24_000;
const TOOL_ENV_VARS = [
  'OPENAI_COMPAT_API_KEY',
  'OPENAI_COMPAT_BASE_URL',
  'OPENAI_COMPAT_MODEL',
  'OPENAI_COMPAT_MAX_TOKENS',
  'OPENAI_COMPAT_TEMPERATURE',
  'OPENAI_COMPAT_THINKING_TYPE',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_MAX_TOKENS',
  'LLM_TEMPERATURE',
  'LLM_THINKING_TYPE',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash command inside /workspace/group. Use this for bioinformatics tools, Python scripts, network requests, and filesystem operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute.' },
          timeout_sec: {
            type: 'integer',
            description: 'Optional timeout in seconds. Defaults to 120.',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          start_line: { type: 'integer', description: 'Optional 1-based start line.' },
          end_line: { type: 'integer', description: 'Optional 1-based end line.' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 text file. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          content: { type: 'string', description: 'Full file contents to write.' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace text in a UTF-8 file. By default exactly one match must exist; set replace_all=true to replace every match.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          old_text: { type: 'string', description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace all matches instead of exactly one.' },
        },
        required: ['file_path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files and directories under a path. Use recursive=true to walk subdirectories.',
      parameters: {
        type: 'object',
        properties: {
          dir_path: { type: 'string', description: 'Directory to inspect. Defaults to /workspace/group.' },
          recursive: { type: 'boolean', description: 'Whether to recurse into subdirectories.' },
          pattern: { type: 'string', description: 'Optional glob-like pattern using * and ?.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_files',
      description:
        'Search text files for a regex pattern and return matching lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regex pattern.' },
          dir_path: { type: 'string', description: 'Directory or file to search. Defaults to /workspace/group.' },
          file_pattern: { type: 'string', description: 'Optional glob-like file filter using * and ?.' },
          case_insensitive: { type: 'boolean', description: 'Whether the regex should be case-insensitive.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_pubmed',
      description:
        'Search PubMed via NCBI E-utilities and return paper metadata (PMID/DOI/title/journal/year/authors).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query, e.g. "CRBN multiple myeloma".',
          },
          max_results: {
            type: 'integer',
            description: 'Number of results to return (1-20, default 5).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        "Send a message to the user or group immediately while you're still working.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send.' },
          sender: { type: 'string', description: 'Optional sender label.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_image',
      description:
        'Send an image file to the user or group after you generate it.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or workspace-relative path to the image file.' },
          caption: { type: 'string', description: 'Optional caption.' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time task. Use context_mode=group when the task depends on prior conversation context.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          schedule_type: {
            type: 'string',
            description: 'cron, interval, or once',
            enum: ['cron', 'interval', 'once'],
          },
          schedule_value: { type: 'string' },
          context_mode: {
            type: 'string',
            description: 'group or isolated',
            enum: ['group', 'isolated'],
          },
          target_group_jid: { type: 'string' },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List scheduled tasks visible to the current group.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_task',
      description: 'Pause a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_task',
      description: 'Resume a paused task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_group',
      description:
        'Register a new WhatsApp group so the agent can respond there. Main group only.',
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          name: { type: 'string' },
          folder: { type: 'string' },
          trigger: { type: 'string' },
        },
        required: ['jid', 'name', 'folder', 'trigger'],
      },
    },
  },
];

type ToolExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;

interface ToolExecutionResult {
  output: string;
  success: boolean;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function writeProgress(progress: Omit<AgentProgressEvent, 'timestamp'>, newSessionId?: string): void {
  writeOutput({
    status: 'progress',
    result: null,
    newSessionId,
    progress: {
      ...progress,
      timestamp: new Date().toISOString(),
    },
  });
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function summarizeToolArgs(rawArgs: string, maxChars = 260): string {
  const compact = rawArgs.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, maxChars)}...[truncated ${compact.length - maxChars} chars]`;
}

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function ensureBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return defaultValue;
}

function ensureInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}`);
  }
  return value;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function readConfigValue(containerInput: ContainerInput, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = containerInput.secrets?.[key] ?? process.env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function parseNumberConfig(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function applyRuntimeEnv(containerInput: ContainerInput): void {
  for (const key of PROXY_ENV_KEYS) {
    const val = containerInput.secrets?.[key];
    if (typeof val === 'string' && val.trim()) {
      process.env[key] = val.trim();
    }
  }
}

function loadProviderConfig(containerInput: ContainerInput): ProviderConfig {
  const apiKey = readConfigValue(containerInput, ['OPENAI_COMPAT_API_KEY', 'LLM_API_KEY']);
  const baseUrl = readConfigValue(containerInput, ['OPENAI_COMPAT_BASE_URL', 'LLM_BASE_URL']);
  const model = readConfigValue(containerInput, ['OPENAI_COMPAT_MODEL', 'LLM_MODEL'])
    || 'openapi/claude-4.5-sonnet';

  if (!baseUrl) {
    throw new Error('Missing OPENAI_COMPAT_BASE_URL (or LLM_BASE_URL) in .env');
  }

  if (!apiKey) {
    log('No API key configured (OPENAI_COMPAT_API_KEY/LLM_API_KEY). Continuing without Authorization header.');
  }

  return {
    apiKey,
    apiUrl: normalizeBaseUrl(baseUrl),
    model,
    maxTokens: parseNumberConfig(
      readConfigValue(containerInput, ['OPENAI_COMPAT_MAX_TOKENS', 'LLM_MAX_TOKENS']),
      4096,
    ),
    temperature: parseNumberConfig(
      readConfigValue(containerInput, ['OPENAI_COMPAT_TEMPERATURE', 'LLM_TEMPERATURE']),
      0.2,
    ),
    thinkingType: readConfigValue(containerInput, ['OPENAI_COMPAT_THINKING_TYPE', 'LLM_THINKING_TYPE']),
  };
}

function createToolContext(containerInput: ContainerInput): ToolContext {
  const readableRoots = [
    '/workspace/group',
    '/workspace/global',
    '/workspace/extra',
    '/workspace/ipc',
  ];
  const writableRoots = ['/workspace/group'];

  if (containerInput.isMain) {
    readableRoots.push('/workspace/project');
    writableRoots.push('/workspace/project');
  }

  return {
    containerInput,
    readableRoots,
    writableRoots,
  };
}

function ensureAllowedPath(
  rawPath: string,
  roots: string[],
): string {
  const resolved = path.resolve(rawPath.startsWith('/') ? rawPath : path.join('/workspace/group', rawPath));
  const allowed = roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error(`Path is outside allowed roots: ${resolved}`);
  }
  return resolved;
}

function isProbablyText(content: Buffer): boolean {
  return !content.includes(0);
}

function loadTextFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  if (!isProbablyText(buffer)) {
    throw new Error(`File is not a text file: ${filePath}`);
  }
  return buffer.toString('utf-8');
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern) {
    return true;
  }
  return wildcardToRegExp(pattern).test(name);
}

function formatPubMedResults(
  query: string,
  totalCount: string | undefined,
  items: PubMedSummaryItem[],
): string {
  if (items.length === 0) {
    return `No PubMed results found for query: ${query}`;
  }

  const lines: string[] = [];
  lines.push(
    `Found ${totalCount || 'unknown'} PubMed results for "${query}" (showing ${items.length}):`,
    '',
  );

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const pmid = (item.uid || '').trim();
    const title = (item.title || 'Untitled').replace(/\s+/g, ' ').trim();
    const journal = (item.fulljournalname || item.source || 'Unknown journal').trim();
    const pubdate = (item.pubdate || item.sortpubdate || '').trim();
    const year = (pubdate.match(/\b(19|20)\d{2}\b/) || [])[0] || 'n/a';
    const authorNames = (item.authors || [])
      .map((a) => (a.name || '').trim())
      .filter(Boolean);
    let authors = 'Unknown authors';
    if (authorNames.length > 0) {
      const head = authorNames.slice(0, 6).join(', ');
      authors = authorNames.length > 6 ? `${head}, et al.` : head;
    }

    const doi = (item.articleids || [])
      .find((id) => (id.idtype || '').toLowerCase() === 'doi')
      ?.value?.trim();

    lines.push(`${i + 1}. ${title}`);
    lines.push(`   Authors: ${authors}`);
    lines.push(`   Journal/Year: ${journal} (${year})`);
    if (pmid) lines.push(`   PMID: ${pmid}`);
    if (doi) lines.push(`   DOI: ${doi}`);
    if (pmid) lines.push(`   URL: https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function fetchPubMedJson<T>(url: URL): Promise<T> {
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `PubMed request failed (${response.status}) for ${url.pathname}: ${truncate(raw, 800)}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `PubMed returned invalid JSON for ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function searchPubMed(query: string, maxResults: number): Promise<string> {
  const esearchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
  esearchUrl.searchParams.set('db', 'pubmed');
  esearchUrl.searchParams.set('term', query);
  esearchUrl.searchParams.set('retmax', String(maxResults));
  esearchUrl.searchParams.set('retmode', 'json');
  esearchUrl.searchParams.set('sort', 'relevance');

  const searchData = await fetchPubMedJson<PubMedSearchResponse>(esearchUrl);
  const idList = searchData.esearchresult?.idlist || [];
  if (idList.length === 0) {
    return `No PubMed results found for query: ${query}`;
  }

  const esummaryUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
  esummaryUrl.searchParams.set('db', 'pubmed');
  esummaryUrl.searchParams.set('id', idList.join(','));
  esummaryUrl.searchParams.set('retmode', 'json');

  const summaryData = await fetchPubMedJson<PubMedSummaryResponse>(esummaryUrl);
  const uids = summaryData.result?.uids || idList;

  const items: PubMedSummaryItem[] = uids
    .map((uid) => summaryData.result?.[uid])
    .filter((entry): entry is PubMedSummaryItem =>
      !!entry && !Array.isArray(entry) && typeof entry === 'object',
    );

  return formatPubMedResults(query, searchData.esearchresult?.count, items);
}

function collectPaths(targetPath: string, recursive: boolean, maxEntries = 400): string[] {
  const results: string[] = [];

  const visit = (currentPath: string): void => {
    if (results.length >= maxEntries) {
      return;
    }

    const stat = fs.statSync(currentPath);
    results.push(currentPath);

    if (!recursive || !stat.isDirectory()) {
      return;
    }

    for (const entry of fs.readdirSync(currentPath)) {
      if (results.length >= maxEntries) {
        return;
      }
      visit(path.join(currentPath, entry));
    }
  };

  visit(targetPath);
  return results;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function sessionFilePath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function loadSession(sessionId: string): SessionState | null {
  const filePath = sessionFilePath(sessionId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionState;
  } catch (err) {
    log(`Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function createSession(): SessionState {
  const now = new Date().toISOString();
  return {
    sessionId: `session-${randomUUID()}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function saveSession(session: SessionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionFilePath(session.sessionId), JSON.stringify(session, null, 2));
}

function trimMessages(messages: ChatMessage[], maxChars = 140_000): ChatMessage[] {
  const trimmed: ChatMessage[] = [];
  let total = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const current = messages[i];
    const size = JSON.stringify(current).length;
    if (trimmed.length > 0 && total + size > maxChars) {
      break;
    }
    trimmed.unshift(current);
    total += size;
  }

  return trimmed;
}

function renderConversationArchive(session: SessionState): string {
  const lines: string[] = [
    `# Conversation ${session.sessionId}`,
    '',
    `Updated: ${session.updatedAt}`,
    '',
    '---',
    '',
  ];

  for (const message of session.messages) {
    if (message.role === 'tool') {
      lines.push(`**Tool (${message.name || 'unknown'})**`);
      lines.push('');
      lines.push('```text');
      lines.push(truncate(message.content || '', 3000));
      lines.push('```');
      lines.push('');
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const calledTools = message.tool_calls.map(toolCall => toolCall.function.name).join(', ');
      lines.push(`**Assistant tool call**: ${calledTools}`);
      lines.push('');
      continue;
    }

    const title = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`**${title}**`);
    lines.push('');
    lines.push(message.content || '');
    lines.push('');
  }

  return lines.join('\n');
}

function writeConversationArchive(session: SessionState): void {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  const filePath = path.join(CONVERSATIONS_DIR, `${session.sessionId}.md`);
  fs.writeFileSync(filePath, renderConversationArchive(session));
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : JSON.stringify(part);
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') {
      return text;
    }
    return JSON.stringify(content);
  }

  return '';
}

function loadPromptFragments(containerInput: ContainerInput): string[] {
  const fragments: string[] = [];
  const instructionFiles = ['/workspace/group/CLAUDE.md'];

  if (containerInput.isMain) {
    instructionFiles.unshift('/workspace/project/groups/global/CLAUDE.md');
  } else {
    instructionFiles.unshift('/workspace/global/CLAUDE.md');
  }

  if (fs.existsSync('/workspace/extra')) {
    for (const entry of fs.readdirSync('/workspace/extra')) {
      const candidate = path.join('/workspace/extra', entry, 'CLAUDE.md');
      if (fs.existsSync(candidate)) {
        instructionFiles.push(candidate);
      }
    }
  }

  for (const filePath of instructionFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    fragments.push(`Instructions from ${filePath}:\n${fs.readFileSync(filePath, 'utf-8')}`);
  }

  return fragments;
}

function buildSystemPrompt(containerInput: ContainerInput): string {
  const fragments = [
    [
      'You are Bio, an AI biology research assistant running inside an isolated container.',
      'Prefer doing real analysis with tools over giving purely theoretical answers.',
      'Use bash for BLAST, minimap2, BWA, FastQC, PyMOL, Python scripts, and network calls.',
      'For biomedical literature retrieval, use search_pubmed first.',
      'Use read_file/write_file/edit_file/list_files/grep_files for direct workspace access.',
      'Use send_message for progress updates during long jobs.',
      'Use send_image after generating plots or structure renders.',
      'Keep WhatsApp replies clean: no markdown headings, prefer short paragraphs or bullet lists.',
      'If part of your output is internal reasoning, wrap it in <internal> tags.',
      'Legacy references to mcp__bioclaw__send_message or mcp__bioclaw__send_image map to send_message and send_image in this runtime.',
      'Your writable workspace is primarily /workspace/group. The main group can also modify /workspace/project.',
    ].join('\n'),
    ...loadPromptFragments(containerInput),
  ];

  return fragments.join('\n\n');
}

async function callChatCompletion(
  providerConfig: ProviderConfig,
  messages: ChatMessage[],
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const payload: Record<string, unknown> = {
    model: providerConfig.model,
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto',
    max_tokens: providerConfig.maxTokens,
    temperature: providerConfig.temperature,
  };

  if (providerConfig.thinkingType) {
    payload.thinking = { type: providerConfig.thinkingType };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (providerConfig.apiKey) {
    headers.Authorization = `Bearer ${providerConfig.apiKey}`;
  }

  const response = await fetch(providerConfig.apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed: ChatCompletionResponse;

  try {
    parsed = JSON.parse(raw) as ChatCompletionResponse;
  } catch (err) {
    throw new Error(`Provider returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${truncate(raw, 1200)}`);
  }

  if (!response.ok) {
    const message = parsed.error?.message || raw;
    throw new Error(`Provider request failed (${response.status}): ${truncate(message, 1200)}`);
  }

  const message = parsed.choices?.[0]?.message;
  if (!message) {
    throw new Error(`Provider returned no choices: ${truncate(raw, 1200)}`);
  }

  return {
    content: extractTextContent(message.content),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
  };
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(String(data.text));
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  async bash(args) {
    const command = ensureString(args.command, 'command');
    const timeoutSec = ensureInteger(args.timeout_sec, 'timeout_sec', 120, 1, 600);
    const env = { ...process.env };
    for (const key of TOOL_ENV_VARS) {
      delete env[key];
    }

    try {
      const { stdout, stderr } = await exec(command, {
        cwd: '/workspace/group',
        shell: '/bin/bash',
        timeout: timeoutSec * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env,
      });

      return truncate(
        `exit_code: 0\nstdout:\n${stdout || '(empty)'}\nstderr:\n${stderr || '(empty)'}`,
        MAX_TOOL_OUTPUT_CHARS,
      );
    } catch (err) {
      const error = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return truncate(
        `exit_code: ${error.code ?? 'unknown'}\nstdout:\n${error.stdout || '(empty)'}\nstderr:\n${error.stderr || error.message || '(empty)'}`,
        MAX_TOOL_OUTPUT_CHARS,
      );
    }
  },

  async read_file(args, context) {
    const filePath = ensureAllowedPath(ensureString(args.file_path, 'file_path'), context.readableRoots);
    const content = loadTextFile(filePath);
    const startLine = args.start_line === undefined ? 1 : ensureInteger(args.start_line, 'start_line', 1, 1, 1_000_000);
    const endLine = args.end_line === undefined ? undefined : ensureInteger(args.end_line, 'end_line', startLine, startLine, 1_000_000);
    const lines = content.split('\n');
    const selected = lines.slice(startLine - 1, endLine ?? lines.length);
    const numbered = selected.map((line, index) => `${startLine + index}: ${line}`).join('\n');
    return truncate(numbered, MAX_FILE_READ_CHARS);
  },

  async write_file(args, context) {
    const filePath = ensureAllowedPath(ensureString(args.file_path, 'file_path'), context.writableRoots);
    const content = ensureString(args.content, 'content');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Wrote ${content.length} chars to ${filePath}`;
  },

  async edit_file(args, context) {
    const filePath = ensureAllowedPath(ensureString(args.file_path, 'file_path'), context.writableRoots);
    const oldText = ensureString(args.old_text, 'old_text');
    const newText = typeof args.new_text === 'string' ? args.new_text : String(args.new_text ?? '');
    const replaceAll = ensureBoolean(args.replace_all);
    const original = loadTextFile(filePath);

    const occurrences = original.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`old_text not found in ${filePath}`);
    }
    if (!replaceAll && occurrences !== 1) {
      throw new Error(`old_text matched ${occurrences} times; set replace_all=true to replace every match`);
    }

    const updated = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    fs.writeFileSync(filePath, updated, 'utf-8');
    return `Updated ${filePath}; replaced ${replaceAll ? occurrences : 1} occurrence(s).`;
  },

  async list_files(args, context) {
    const dirPath = args.dir_path
      ? ensureAllowedPath(ensureString(args.dir_path, 'dir_path'), context.readableRoots)
      : '/workspace/group';
    const recursive = ensureBoolean(args.recursive);
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;
    const paths = collectPaths(dirPath, recursive)
      .filter(currentPath => matchesPattern(path.basename(currentPath), pattern))
      .map(currentPath => {
        const stat = fs.statSync(currentPath);
        const suffix = stat.isDirectory() ? '/' : '';
        return `${currentPath}${suffix}`;
      });

    return truncate(paths.join('\n') || '(no matches)', MAX_TOOL_OUTPUT_CHARS);
  },

  async grep_files(args, context) {
    const pattern = ensureString(args.pattern, 'pattern');
    const dirPath = args.dir_path
      ? ensureAllowedPath(ensureString(args.dir_path, 'dir_path'), context.readableRoots)
      : '/workspace/group';
    const filePattern = typeof args.file_pattern === 'string' ? args.file_pattern : undefined;
    const caseInsensitive = ensureBoolean(args.case_insensitive);
    const regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
    const matches: string[] = [];

    for (const currentPath of collectPaths(dirPath, true, 500)) {
      const stat = fs.statSync(currentPath);
      if (stat.isDirectory()) {
        continue;
      }
      if (!matchesPattern(path.basename(currentPath), filePattern)) {
        continue;
      }
      if (stat.size > 1_000_000) {
        continue;
      }

      try {
        const content = loadTextFile(currentPath);
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (regex.test(lines[index])) {
            matches.push(`${currentPath}:${index + 1}: ${lines[index]}`);
            if (matches.length >= 200) {
              return truncate(matches.join('\n'), MAX_TOOL_OUTPUT_CHARS);
            }
          }
        }
      } catch {
        continue;
      }
    }

    return truncate(matches.join('\n') || '(no matches)', MAX_TOOL_OUTPUT_CHARS);
  },

  async search_pubmed(args) {
    const query = ensureString(args.query, 'query');
    const maxResults = ensureInteger(args.max_results, 'max_results', 5, 1, 20);
    return searchPubMed(query, maxResults);
  },

  async send_message(args, context) {
    const text = ensureString(args.text, 'text');
    const sender = typeof args.sender === 'string' ? args.sender : undefined;
    const payload: Record<string, string | undefined> = {
      type: 'message',
      chatJid: context.containerInput.chatJid,
      text,
      sender,
      groupFolder: context.containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, payload);
    return 'Message sent.';
  },

  async send_image(args, context) {
    const srcPath = ensureAllowedPath(ensureString(args.file_path, 'file_path'), context.readableRoots);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`File not found: ${srcPath}`);
    }

    fs.mkdirSync(FILES_DIR, { recursive: true });
    const ext = path.extname(srcPath) || '.png';
    const destFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const destPath = path.join(FILES_DIR, destFilename);
    fs.copyFileSync(srcPath, destPath);

    writeIpcFile(MESSAGES_DIR, {
      type: 'image',
      chatJid: context.containerInput.chatJid,
      filePath: `files/${destFilename}`,
      caption: typeof args.caption === 'string' ? args.caption : undefined,
      groupFolder: context.containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    });

    return `Image queued for sending: ${destFilename}`;
  },

  async schedule_task(args, context) {
    const prompt = ensureString(args.prompt, 'prompt');
    const scheduleType = ensureString(args.schedule_type, 'schedule_type');
    const scheduleValue = ensureString(args.schedule_value, 'schedule_value');
    const contextMode = typeof args.context_mode === 'string' ? args.context_mode : 'group';

    if (!['cron', 'interval', 'once'].includes(scheduleType)) {
      throw new Error('schedule_type must be cron, interval, or once');
    }

    if (!['group', 'isolated'].includes(contextMode)) {
      throw new Error('context_mode must be group or isolated');
    }

    if (scheduleType === 'cron') {
      CronExpressionParser.parse(scheduleValue);
    } else if (scheduleType === 'interval') {
      const ms = parseInt(scheduleValue, 10);
      if (Number.isNaN(ms) || ms <= 0) {
        throw new Error('interval schedule_value must be positive milliseconds');
      }
    } else {
      const date = new Date(scheduleValue);
      if (Number.isNaN(date.getTime())) {
        throw new Error('once schedule_value must be an ISO timestamp');
      }
    }

    const targetJid = context.containerInput.isMain && typeof args.target_group_jid === 'string'
      ? args.target_group_jid
      : context.containerInput.chatJid;

    const filename = writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: contextMode,
      targetJid,
      createdBy: context.containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    });

    return `Task scheduled (${filename}): ${scheduleType} - ${scheduleValue}`;
  },

  async list_tasks(_args, context) {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
    if (!fs.existsSync(tasksFile)) {
      return 'No scheduled tasks found.';
    }

    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
      id: string;
      groupFolder: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      status: string;
      next_run: string;
    }>;

    const visibleTasks = context.containerInput.isMain
      ? allTasks
      : allTasks.filter(task => task.groupFolder === context.containerInput.groupFolder);

    if (visibleTasks.length === 0) {
      return 'No scheduled tasks found.';
    }

    return visibleTasks
      .map(task =>
        `- [${task.id}] ${task.prompt.slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`,
      )
      .join('\n');
  },

  async pause_task(args, context) {
    const taskId = ensureString(args.task_id, 'task_id');
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId,
      groupFolder: context.containerInput.groupFolder,
      isMain: context.containerInput.isMain,
      timestamp: new Date().toISOString(),
    });
    return `Task ${taskId} pause requested.`;
  },

  async resume_task(args, context) {
    const taskId = ensureString(args.task_id, 'task_id');
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId,
      groupFolder: context.containerInput.groupFolder,
      isMain: context.containerInput.isMain,
      timestamp: new Date().toISOString(),
    });
    return `Task ${taskId} resume requested.`;
  },

  async cancel_task(args, context) {
    const taskId = ensureString(args.task_id, 'task_id');
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId,
      groupFolder: context.containerInput.groupFolder,
      isMain: context.containerInput.isMain,
      timestamp: new Date().toISOString(),
    });
    return `Task ${taskId} cancellation requested.`;
  },

  async register_group(args, context) {
    if (!context.containerInput.isMain) {
      throw new Error('Only the main group can register new groups.');
    }

    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: ensureString(args.jid, 'jid'),
      name: ensureString(args.name, 'name'),
      folder: ensureString(args.folder, 'folder'),
      trigger: ensureString(args.trigger, 'trigger'),
      timestamp: new Date().toISOString(),
    });

    return `Group "${ensureString(args.name, 'name')}" registered. It will start receiving messages immediately.`;
  },
};

async function executeToolCall(toolCall: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
  const executor = TOOL_EXECUTORS[toolCall.function.name];
  if (!executor) {
    return {
      success: false,
      output: JSON.stringify({ ok: false, error: `Unknown tool: ${toolCall.function.name}` }),
    };
  }

  let args: Record<string, unknown> = {};
  try {
    args = toolCall.function.arguments
      ? JSON.parse(toolCall.function.arguments) as Record<string, unknown>
      : {};
  } catch (err) {
    return {
      success: false,
      output: JSON.stringify({
        ok: false,
        error: `Failed to parse tool arguments: ${err instanceof Error ? err.message : String(err)}`,
      }),
    };
  }

  try {
    const result = await executor(args, context);
    return {
      success: true,
      output: truncate(
        JSON.stringify({ ok: true, result: formatToolResult(result) }, null, 2),
        MAX_TOOL_OUTPUT_CHARS,
      ),
    };
  } catch (err) {
    return {
      success: false,
      output: truncate(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }, null, 2),
        MAX_TOOL_OUTPUT_CHARS,
      ),
    };
  }
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  providerConfig: ProviderConfig,
): Promise<{ newSessionId: string; closedDuringQuery: boolean; result: string | null }> {
  const session = sessionId ? loadSession(sessionId) || createSession() : createSession();
  const toolContext = createToolContext(containerInput);
  const systemPrompt: ChatMessage = {
    role: 'system',
    content: buildSystemPrompt(containerInput),
  };

  session.messages.push({ role: 'user', content: prompt });
  writeProgress(
    {
      type: 'lifecycle',
      stage: 'start',
      message: 'query_started',
    },
    session.sessionId,
  );

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundNumber = round + 1;
    if (shouldClose()) {
      writeProgress(
        {
          type: 'lifecycle',
          stage: 'info',
          message: 'close_sentinel_during_query',
        },
        session.sessionId,
      );
      saveSession(session);
      writeConversationArchive(session);
      return {
        newSessionId: session.sessionId,
        closedDuringQuery: true,
        result: null,
      };
    }

    log(`Calling provider model ${providerConfig.model} (round ${roundNumber})`);
    writeProgress({
      type: 'provider',
      stage: 'start',
      round: roundNumber,
      model: providerConfig.model,
    }, session.sessionId);

    const providerStartedAt = Date.now();
    let response: { content: string; toolCalls: ToolCall[] };
    try {
      response = await callChatCompletion(
        providerConfig,
        [systemPrompt, ...trimMessages(session.messages)],
      );
    } catch (err) {
      writeProgress({
        type: 'provider',
        stage: 'error',
        round: roundNumber,
        model: providerConfig.model,
        durationMs: Date.now() - providerStartedAt,
        message: err instanceof Error ? err.message : String(err),
      }, session.sessionId);
      throw err;
    }
    const providerDurationMs = Date.now() - providerStartedAt;
    writeProgress({
      type: 'provider',
      stage: 'end',
      round: roundNumber,
      model: providerConfig.model,
      durationMs: providerDurationMs,
      toolCalls: response.toolCalls.length,
      contentChars: response.content.trim().length,
    }, session.sessionId);

    session.messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    if (response.toolCalls.length === 0) {
      writeProgress({
        type: 'lifecycle',
        stage: 'info',
        message: 'final_response_ready',
        contentChars: response.content.trim().length,
      }, session.sessionId);
      saveSession(session);
      writeConversationArchive(session);
      return {
        newSessionId: session.sessionId,
        closedDuringQuery: false,
        result: response.content.trim() || null,
      };
    }

    for (const toolCall of response.toolCalls) {
      log(`Executing tool ${toolCall.function.name}`);
      writeProgress({
        type: 'tool',
        stage: 'start',
        round: roundNumber,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        argsSummary: summarizeToolArgs(toolCall.function.arguments || '{}'),
      }, session.sessionId);

      const toolStartedAt = Date.now();
      const toolResult = await executeToolCall(toolCall, toolContext);
      const toolDurationMs = Date.now() - toolStartedAt;
      writeProgress({
        type: 'tool',
        stage: toolResult.success ? 'end' : 'error',
        round: roundNumber,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        durationMs: toolDurationMs,
        success: toolResult.success,
      }, session.sessionId);

      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResult.output,
      });
    }
  }

  saveSession(session);
  writeConversationArchive(session);
  throw new Error(`Model exceeded tool limit (${MAX_TOOL_ROUNDS} rounds)`);
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* ignore */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  // Propagate proxy variables into runtime/tool process environment so
  // `bash`/`curl`/Python requests can access external network when needed.
  applyRuntimeEnv(containerInput);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += `\n${pending.join('\n')}`;
  }

  let latestSessionId = containerInput.sessionId;

  try {
    const providerConfig = loadProviderConfig(containerInput);
    let sessionId = containerInput.sessionId;

    while (true) {
      const queryResult = await runQuery(prompt, sessionId, containerInput, providerConfig);
      sessionId = queryResult.newSessionId;
      latestSessionId = sessionId;

      if (queryResult.result !== null) {
        writeOutput({
          status: 'success',
          result: queryResult.result,
          newSessionId: sessionId,
        });
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel received during active query, exiting');
        break;
      }

      writeProgress({
        type: 'lifecycle',
        stage: 'info',
        message: 'waiting_for_follow_up_message',
      }, sessionId);
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received while idle, exiting');
        writeProgress({
          type: 'lifecycle',
          stage: 'info',
          message: 'close_sentinel_while_idle',
        }, sessionId);
        break;
      }

      writeProgress({
        type: 'lifecycle',
        stage: 'info',
        message: 'received_follow_up_message',
      }, sessionId);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeProgress({
      type: 'lifecycle',
      stage: 'error',
      message: errorMessage,
    }, latestSessionId);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: latestSessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
