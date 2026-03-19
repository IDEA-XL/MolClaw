/**
 * MolClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * This runner talks to an OpenAI-compatible `/chat/completions` endpoint and
 * implements a small tool runtime directly, so MolClaw can work with gateway
 * providers instead of Anthropic's SDK.
 */

import { exec as execCallback } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';
import {
  ClaudeSkillManager,
  findClaudeSkill,
  renderClaudeSkillForContext,
  renderClaudeSkillInvocationHint,
  renderClaudeSkillLoadedReminder,
  type ClaudeSkillCandidate,
  type ClaudeSkillRegistry,
  type ClaudeSkillInvocationHint,
} from './skills.js';
import {
  isSkillToolName,
  serializeToolExecutionResult,
} from './tool-results.js';
import {
  buildDefaultMemoryScopes,
  getMemoryEntryById,
  renderMemoryContextBlock,
  saveMemoryEntry,
  selectMemoryForPrompt,
  searchMemoryEntries,
  type MemoryEntry,
  type MemoryScopeDescriptor,
  type MemorySearchScope,
} from './memory.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  providerOverride?: {
    provider: string;
    model: string;
  };
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
  type: 'lifecycle' | 'provider' | 'tool' | 'context';
  stage: 'start' | 'end' | 'info' | 'error';
  message?: string;
  round?: number;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  toolCallNames?: string;
  argsSummary?: string;
  toolArgs?: Record<string, unknown>;
  durationMs?: number;
  success?: boolean;
  contentChars?: number;
  contentTokenCount?: number;
  contentPreview?: string;
  reasoningChars?: number;
  reasoningTokenCount?: number;
  reasoningPreview?: string;
  contentSource?: string;
  reasoningSource?: string;
  outputPreview?: string;
  output?: string;
  toolCalls?: number;
  historyMessageCount?: number;
  historyCharCount?: number;
  historyTokenCount?: number;
  trimmedMessageCount?: number;
  trimmedCharCount?: number;
  trimmedTokenCount?: number;
  memoryHitCount?: number;
  memoryHitIds?: string[];
  pinnedMemoryCount?: number;
  recentMemoryCount?: number;
  matchedMemoryCount?: number;
  durableMemoryTokenCount?: number;
  sessionSummaryTokenCount?: number;
  promptTokenCount?: number;
  completionTokenCount?: number;
  totalTokenCount?: number;
  claudeSkillTrace?: Array<{
    name: string;
    score: number;
    reasons: string[];
    explicitlyRequested: boolean;
    invocationTrigger?: string;
    invocationArgs?: string;
    model?: string;
    userInvocable?: boolean;
    disableModelInvocation?: boolean;
  }>;
  parseErrors?: Array<{
    filePath: string;
    message: string;
  }>;
  claudeSkillRuntime?: {
    skillsBaseDir: string;
    cacheStatus: 'cold' | 'hit' | 'refresh';
    snapshotKey: string;
    totalSkills: number;
    parseErrorCount: number;
    lastRefreshAt: string;
    availableSkillCount?: number;
    explicitInvocationCount?: number;
    materializedSkillCount?: number;
    materializedSkillNames?: string[];
  };
  claudeSkillConformance?: {
    status:
      | 'none'
      | 'loaded'
      | 'post_load_tools_seen'
      | 'referenced_skill_artifacts'
      | 'final_response_after_skill';
    activeSkillNames: string[];
    loadedSkillNames: string[];
    skillToolCallCount: number;
    loadRounds: number[];
    firstPostLoadToolName?: string;
    postLoadToolNames?: string[];
    referencedSkillNames?: string[];
    referencedSkillBaseDirs?: string[];
    referencedPaths?: string[];
    finalResponseProduced?: boolean;
  };
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

interface ProviderContentTextPart {
  type: 'text';
  text: string;
}

interface ProviderContentImagePart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

type ProviderContentPart = ProviderContentTextPart | ProviderContentImagePart;

interface ProviderChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ProviderContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ProviderMessageMaterializationResult {
  messages: ProviderChatMessage[];
  inlineImageRequested: number;
  inlineImageAttached: number;
  warnings: string[];
}

interface SessionState {
  sessionId: string;
  messages: ChatMessage[];
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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: ToolCall[];
      reasoning?: unknown;
      reasoning_content?: unknown;
      thinking?: unknown;
      analysis?: unknown;
      text?: unknown;
      output_text?: unknown;
    };
    reasoning?: unknown;
    reasoning_content?: unknown;
    thinking?: unknown;
    text?: unknown;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ProviderConfig {
  apiKey?: string;
  apiUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  thinkingType?: string;
  supportsImageInput: boolean | null;
  imageSupportReason: string;
}

interface ToolContext {
  containerInput: ContainerInput;
  readableRoots: string[];
  writableRoots: string[];
  memoryScopes: MemoryScopeDescriptor[];
  sessionId?: string;
  currentRound?: number;
  claudeSkillRegistry: ClaudeSkillRegistry;
  claudeSkillInvocationHints: Map<string, ClaudeSkillInvocationHint>;
}

interface AutoMaterializedSkillsResult {
  names: string[];
  messages: ChatMessage[];
  trace: Array<{
    name: string;
    score: number;
    reasons: string[];
  }>;
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

const OUTPUT_START_MARKER = '---MOLCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---MOLCLAW_OUTPUT_END---';

const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const FILES_DIR = path.join(IPC_DIR, 'files');
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const MEMORY_DIR = path.join(IPC_DIR, 'memory');
const SESSION_DIR = '/home/node/.claude/openai-sessions';
const CONVERSATIONS_DIR = '/workspace/group/conversations';
const MAX_TOOL_ROUNDS = 24;
const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_SKILL_TOOL_OUTPUT_CHARS = 48_000;
const MAX_FILE_READ_CHARS = 24_000;
const DEFAULT_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const INLINE_IMAGE_MAX_BYTES = Math.max(
  64 * 1024,
  parseInt(
    process.env.OPENAI_COMPAT_INLINE_IMAGE_MAX_BYTES
      || process.env.LLM_INLINE_IMAGE_MAX_BYTES
      || `${DEFAULT_INLINE_IMAGE_MAX_BYTES}`,
    10,
  ) || DEFAULT_INLINE_IMAGE_MAX_BYTES,
);
const DEFAULT_INLINE_IMAGE_MAX_COUNT = 3;
const ROLLING_SUMMARY_TRIGGER_TOKENS = Math.max(
  4_000,
  parseInt(
    process.env.MOLCLAW_ROLLING_SUMMARY_TRIGGER_TOKENS || '24000',
    10,
  ) || 24_000,
);
const ROLLING_SUMMARY_TAIL_MESSAGES = Math.max(
  4,
  parseInt(
    process.env.MOLCLAW_ROLLING_SUMMARY_TAIL_MESSAGES || '10',
    10,
  ) || 10,
);
const INLINE_IMAGE_MAX_COUNT = Math.max(
  1,
  parseInt(
    process.env.OPENAI_COMPAT_INLINE_IMAGE_MAX_COUNT
      || process.env.LLM_INLINE_IMAGE_MAX_COUNT
      || `${DEFAULT_INLINE_IMAGE_MAX_COUNT}`,
    10,
  ) || DEFAULT_INLINE_IMAGE_MAX_COUNT,
);
const TOOL_ENV_VARS = [
  'MODEL_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'OPENROUTER_MULTIMODAL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_MODEL',
  'OPENAI_COMPATIBLE_MAX_TOKENS',
  'OPENAI_COMPATIBLE_TEMPERATURE',
  'OPENAI_COMPATIBLE_THINKING_TYPE',
  'OPENAI_COMPATIBLE_MULTIMODAL',
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

const CORE_TOOL_DEFINITIONS: ToolDefinition[] = [
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
      name: 'save_memory',
      description:
        'Save durable information that should persist beyond the current round or session.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short memory title.',
          },
          content: {
            type: 'string',
            description: 'Durable memory content to store.',
          },
          kind: {
            type: 'string',
            description: 'Memory kind such as preference, rule, fact, project_context, artifact_note, or summary.',
          },
          scope: {
            type: 'string',
            description: 'Where to store the memory.',
            enum: ['group', 'global', 'project'],
          },
          tags: {
            type: 'array',
            description: 'Optional tags used for later retrieval.',
            items: { type: 'string' },
          },
          pinned: {
            type: 'boolean',
            description: 'Pinned memories should be preferred during future retrieval.',
          },
          source: {
            type: 'string',
            description: 'Optional provenance label such as tool, manual, imported, or session_rollup.',
          },
        },
        required: ['title', 'content', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Search durable memory broadly and return lightweight candidates. Use memory_get(id) to fetch full content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Broad query string for tolerant memory retrieval.',
          },
          scope: {
            type: 'string',
            description: 'Optional scope filter. Defaults to all accessible scopes.',
            enum: ['all', 'group', 'global', 'project'],
          },
          limit: {
            type: 'integer',
            description: 'Maximum results to return (1-20, default 5).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_get',
      description:
        'Fetch one durable memory entry by id and return its full content.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory entry id returned by memory_search.',
          },
        },
        required: ['id'],
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

function buildToolDefinitions(skillTool: ToolDefinition | null): ToolDefinition[] {
  return skillTool
    ? [...CORE_TOOL_DEFINITIONS, skillTool]
    : CORE_TOOL_DEFINITIONS;
}

function getCoreToolDefinition(toolName: string): ToolDefinition {
  const tool = CORE_TOOL_DEFINITIONS.find(
    (definition) => definition.function.name === toolName,
  );
  if (!tool) {
    throw new Error(`Missing core tool definition: ${toolName}`);
  }
  return tool;
}

type ToolExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;

interface ToolExecutionResult {
  output: string;
  modelContent: string;
  success: boolean;
}

interface RollingSummaryUpdate {
  summary: NonNullable<SessionState['rollingSummary']>;
  removedMessageCount: number;
  retainedMessageCount: number;
}

interface ActiveLoadedSkill {
  name: string;
  baseDir: string;
  loadedRound: number;
}

interface SkillConformanceState {
  activeSkills: Map<string, ActiveLoadedSkill>;
  loadedSkillNames: Set<string>;
  skillToolCallCount: number;
  loadRounds: number[];
  firstPostLoadToolName?: string;
  postLoadToolNames: string[];
  referencedSkillNames: Set<string>;
  referencedSkillBaseDirs: Set<string>;
  referencedPaths: Set<string>;
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

function parseToolArgs(rawArgs: string): Record<string, unknown> | null {
  try {
    const parsed = rawArgs ? JSON.parse(rawArgs) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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

function ensureStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    return entry.trim();
  }).filter((entry) => entry.length > 0);
  return [...new Set(normalized)];
}

function ensureEnumValue<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
): T {
  const normalized = ensureString(value, fieldName) as T;
  if (!allowedValues.includes(normalized)) {
    throw new Error(
      `${fieldName} must be one of: ${allowedValues.join(', ')}`,
    );
  }
  return normalized;
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

function parseBooleanConfig(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return null;
}

function inferImageSupportFromModel(model: string): boolean | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;

  const obviousTextOnly = /(embedding|rerank|whisper|tts|asr|speech|bge|e5-)/i;
  if (obviousTextOnly.test(normalized)) {
    return false;
  }

  const multimodalHints = [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /\bvision\b/i,
    /\bvl\b/i,
    /gemini/i,
    /claude-3/i,
    /claude-4/i,
    /qwen.*vl/i,
    /llava/i,
    /minicpm-v/i,
    /glm-4v/i,
    /internvl/i,
    /pixtral/i,
    /yi-vl/i,
  ];

  for (const hint of multimodalHints) {
    if (hint.test(normalized)) return true;
  }

  return null;
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
  const requestedProviderRaw = (
    containerInput.providerOverride?.provider
    || readConfigValue(containerInput, ['MODEL_PROVIDER'])
    || ''
  ).trim().toLowerCase();
  const requestedProvider =
    requestedProviderRaw === 'openrouter'
      ? 'openrouter'
      : requestedProviderRaw === 'openai-compatible'
        || requestedProviderRaw === 'openai_compatible'
        ? 'openai-compatible'
        : '';

  if (requestedProviderRaw === 'anthropic') {
    log('MODEL_PROVIDER=anthropic is not supported in this runner; falling back to OpenAI-compatible mode.');
  }

  const hasOpenRouterConfig = !!readConfigValue(containerInput, [
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_MODEL',
  ]);
  const selectedProvider =
    requestedProvider
    || (hasOpenRouterConfig ? 'openrouter' : 'openai-compatible');

  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let maxTokensRaw: string | undefined;
  let temperatureRaw: string | undefined;
  let thinkingTypeRaw: string | undefined;
  let multimodalConfigRaw: string | undefined;

  if (selectedProvider === 'openrouter') {
    apiKey = readConfigValue(containerInput, [
      'OPENROUTER_API_KEY',
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPAT_API_KEY',
      'LLM_API_KEY',
    ]);
    baseUrl = readConfigValue(containerInput, ['OPENROUTER_BASE_URL'])
      || 'https://openrouter.ai/api/v1';
    model =
      (containerInput.providerOverride?.model || '').trim()
      || readConfigValue(containerInput, ['OPENROUTER_MODEL'])
      || 'openai/gpt-4.1-mini';
    maxTokensRaw = readConfigValue(containerInput, [
      'OPENROUTER_MAX_TOKENS',
      'OPENAI_COMPATIBLE_MAX_TOKENS',
      'OPENAI_COMPAT_MAX_TOKENS',
      'LLM_MAX_TOKENS',
    ]);
    temperatureRaw = readConfigValue(containerInput, [
      'OPENROUTER_TEMPERATURE',
      'OPENAI_COMPATIBLE_TEMPERATURE',
      'OPENAI_COMPAT_TEMPERATURE',
      'LLM_TEMPERATURE',
    ]);
    thinkingTypeRaw = readConfigValue(containerInput, [
      'OPENROUTER_THINKING_TYPE',
      'OPENAI_COMPATIBLE_THINKING_TYPE',
      'OPENAI_COMPAT_THINKING_TYPE',
      'LLM_THINKING_TYPE',
    ]);
    multimodalConfigRaw = readConfigValue(containerInput, [
      'OPENROUTER_MULTIMODAL',
      'OPENAI_COMPATIBLE_MULTIMODAL',
      'OPENAI_COMPAT_MULTIMODAL',
      'LLM_MULTIMODAL',
      'OPENAI_COMPATIBLE_SUPPORTS_IMAGE',
      'OPENAI_COMPAT_SUPPORTS_IMAGE',
      'LLM_SUPPORTS_IMAGE',
    ]);
  } else {
    apiKey = readConfigValue(containerInput, [
      'OPENAI_COMPATIBLE_API_KEY',
      'OPENAI_COMPAT_API_KEY',
      'LLM_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
    baseUrl = readConfigValue(containerInput, [
      'OPENAI_COMPATIBLE_BASE_URL',
      'OPENAI_COMPAT_BASE_URL',
      'LLM_BASE_URL',
    ]);
    model =
      (containerInput.providerOverride?.model || '').trim()
      || readConfigValue(containerInput, [
        'OPENAI_COMPATIBLE_MODEL',
        'OPENAI_COMPAT_MODEL',
        'LLM_MODEL',
      ])
      || 'openapi/claude-4.5-sonnet';
    maxTokensRaw = readConfigValue(containerInput, [
      'OPENAI_COMPATIBLE_MAX_TOKENS',
      'OPENAI_COMPAT_MAX_TOKENS',
      'LLM_MAX_TOKENS',
      'OPENROUTER_MAX_TOKENS',
    ]);
    temperatureRaw = readConfigValue(containerInput, [
      'OPENAI_COMPATIBLE_TEMPERATURE',
      'OPENAI_COMPAT_TEMPERATURE',
      'LLM_TEMPERATURE',
      'OPENROUTER_TEMPERATURE',
    ]);
    thinkingTypeRaw = readConfigValue(containerInput, [
      'OPENAI_COMPATIBLE_THINKING_TYPE',
      'OPENAI_COMPAT_THINKING_TYPE',
      'LLM_THINKING_TYPE',
      'OPENROUTER_THINKING_TYPE',
    ]);
    multimodalConfigRaw = readConfigValue(containerInput, [
      'OPENAI_COMPATIBLE_MULTIMODAL',
      'OPENAI_COMPAT_MULTIMODAL',
      'LLM_MULTIMODAL',
      'OPENROUTER_MULTIMODAL',
      'OPENAI_COMPATIBLE_SUPPORTS_IMAGE',
      'OPENAI_COMPAT_SUPPORTS_IMAGE',
      'LLM_SUPPORTS_IMAGE',
    ]);
  }

  if (!baseUrl) {
    throw new Error(
      'Missing provider base URL. Set OPENROUTER_BASE_URL or OPENAI_COMPATIBLE_BASE_URL or OPENAI_COMPAT_BASE_URL (or LLM_BASE_URL).',
    );
  }

  if (!apiKey) {
    log(
      'No API key configured (OPENROUTER_API_KEY / OPENAI_COMPATIBLE_API_KEY / OPENAI_COMPAT_API_KEY / LLM_API_KEY). Continuing without Authorization header.',
    );
  }

  const finalModel = model || 'openai/gpt-4.1-mini';
  const multimodalConfigured = parseBooleanConfig(multimodalConfigRaw);
  const multimodalInferred = inferImageSupportFromModel(finalModel);
  const supportsImageInput =
    multimodalConfigured !== null ? multimodalConfigured : multimodalInferred;
  const imageSupportReason =
    multimodalConfigured !== null
      ? `configured by env (${multimodalConfigRaw})`
      : multimodalInferred !== null
        ? `inferred from model name (${finalModel})`
        : `unknown for model (${finalModel})`;

  return {
    apiKey,
    apiUrl: normalizeBaseUrl(baseUrl),
    model: finalModel,
    maxTokens: parseNumberConfig(maxTokensRaw, 4096),
    temperature: parseNumberConfig(temperatureRaw, 0.2),
    thinkingType: thinkingTypeRaw,
    supportsImageInput,
    imageSupportReason,
  };
}

function createToolContext(
  containerInput: ContainerInput,
  claudeSkillRegistry: ClaudeSkillRegistry,
): ToolContext {
  const readableRoots = [
    '/workspace/group',
    '/workspace/global',
    '/workspace/extra',
    '/workspace/ipc',
  ];
  const writableRoots = ['/workspace/group'];

  if (containerInput.isMain) {
    writableRoots.push('/workspace/global');
    readableRoots.push('/workspace/project');
    writableRoots.push('/workspace/project');
  }

  return {
    containerInput,
    readableRoots,
    writableRoots,
    memoryScopes: buildDefaultMemoryScopes({
      groupFolder: containerInput.groupFolder,
      readableRoots,
      writableRoots,
    }),
    claudeSkillRegistry,
    claudeSkillInvocationHints: new Map(),
  };
}

function chooseAutoMaterializedSkills(
  candidates: ClaudeSkillCandidate[],
): ClaudeSkillCandidate[] {
  return candidates
    .filter((candidate) => candidate.explicitlyRequested)
    .slice(0, 2);
}

function buildAutoMaterializedSkillMessages(
  candidates: ClaudeSkillCandidate[],
): AutoMaterializedSkillsResult {
  const selected = chooseAutoMaterializedSkills(candidates);
  if (selected.length === 0) {
    return { names: [], messages: [], trace: [] };
  }

  const content = [
    'The following skill instructions were auto-loaded because the user explicitly invoked these skills.',
    ...selected.map((candidate) => [
      `Auto-loaded skill: ${candidate.skill.frontmatter.name}`,
      `Selection reasons: ${candidate.reasons.join(', ') || 'none'}`,
      renderClaudeSkillInvocationHint(candidate.invocationHint),
      renderClaudeSkillForContext(candidate.skill),
    ].filter(Boolean).join('\n')),
  ].join('\n\n');

  return {
    names: selected.map((candidate) => candidate.skill.frontmatter.name),
    messages: [
      {
        role: 'system',
        content,
      },
    ],
    trace: selected.map((candidate) => ({
      name: candidate.skill.frontmatter.name,
      score: candidate.score,
      reasons: candidate.reasons,
    })),
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

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringLeaves(entry));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .flatMap((entry) => collectStringLeaves(entry));
  }
  return [];
}

function normalizePathLikeString(value: string): string {
  return value.replace(/\\/g, '/');
}

function createSkillConformanceState(): SkillConformanceState {
  return {
    activeSkills: new Map(),
    loadedSkillNames: new Set(),
    skillToolCallCount: 0,
    loadRounds: [],
    postLoadToolNames: [],
    referencedSkillNames: new Set(),
    referencedSkillBaseDirs: new Set(),
    referencedPaths: new Set(),
  };
}

function buildSkillConformanceSnapshot(
  state: SkillConformanceState,
  finalResponseProduced = false,
): AgentProgressEvent['claudeSkillConformance'] | null {
  if (state.loadedSkillNames.size === 0 && state.activeSkills.size === 0) {
    return null;
  }

  let status: NonNullable<AgentProgressEvent['claudeSkillConformance']>['status'] = 'loaded';
  if (state.referencedPaths.size > 0) {
    status = finalResponseProduced ? 'final_response_after_skill' : 'referenced_skill_artifacts';
  } else if (state.postLoadToolNames.length > 0) {
    status = 'post_load_tools_seen';
  } else if (finalResponseProduced) {
    status = 'final_response_after_skill';
  }

  return {
    status,
    activeSkillNames: Array.from(state.activeSkills.values()).map((entry) => entry.name),
    loadedSkillNames: Array.from(state.loadedSkillNames.values()),
    skillToolCallCount: state.skillToolCallCount,
    loadRounds: [...state.loadRounds],
    firstPostLoadToolName: state.firstPostLoadToolName,
    postLoadToolNames: [...state.postLoadToolNames],
    referencedSkillNames: Array.from(state.referencedSkillNames.values()),
    referencedSkillBaseDirs: Array.from(state.referencedSkillBaseDirs.values()),
    referencedPaths: Array.from(state.referencedPaths.values()),
    finalResponseProduced,
  };
}

function buildSkillConformancePreview(
  snapshot: NonNullable<AgentProgressEvent['claudeSkillConformance']>,
): string {
  return [
    `status=${snapshot.status}`,
    `loaded=${snapshot.loadedSkillNames.join(', ') || 'none'}`,
    snapshot.firstPostLoadToolName ? `first_post_load_tool=${snapshot.firstPostLoadToolName}` : '',
    snapshot.referencedSkillNames && snapshot.referencedSkillNames.length > 0
      ? `artifact_refs=${snapshot.referencedSkillNames.join(', ')}`
      : 'artifact_refs=none',
  ]
    .filter(Boolean)
    .join(' | ');
}

function updateSkillConformanceFromTool(
  state: SkillConformanceState,
  toolName: string,
  toolArgs: Record<string, unknown>,
  roundNumber: number,
  registry: ClaudeSkillRegistry,
  toolSucceeded: boolean,
): void {
  if (isSkillToolName(toolName)) {
    if (!toolSucceeded) {
      return;
    }
    const requested = typeof toolArgs.skill === 'string'
      ? toolArgs.skill
      : (typeof toolArgs.skill_name === 'string' ? toolArgs.skill_name : '');
    const loadedSkill = requested ? findClaudeSkill(registry, requested) : null;
    if (!loadedSkill) {
      return;
    }
    state.skillToolCallCount += 1;
    state.loadedSkillNames.add(loadedSkill.frontmatter.name);
    state.loadRounds.push(roundNumber);
    state.activeSkills.set(loadedSkill.frontmatter.name, {
      name: loadedSkill.frontmatter.name,
      baseDir: loadedSkill.baseDir,
      loadedRound: roundNumber,
    });
    return;
  }

  if (state.activeSkills.size === 0) {
    return;
  }

  state.postLoadToolNames.push(toolName);
  if (!state.firstPostLoadToolName) {
    state.firstPostLoadToolName = toolName;
  }

  const stringLeaves = collectStringLeaves(toolArgs).map((value) => normalizePathLikeString(value));
  for (const skill of state.activeSkills.values()) {
    const normalizedBaseDir = normalizePathLikeString(skill.baseDir);
    for (const text of stringLeaves) {
      if (!text.includes(normalizedBaseDir)) {
        continue;
      }
      state.referencedSkillNames.add(skill.name);
      state.referencedSkillBaseDirs.add(skill.baseDir);
      state.referencedPaths.add(text);
    }
  }
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

function enqueueNoticeMessage(containerInput: ContainerInput, text: string): void {
  const message = text.trim();
  if (!message) return;
  writeIpcFile(MESSAGES_DIR, {
    type: 'message',
    chatJid: containerInput.chatJid,
    text: message,
    groupFolder: containerInput.groupFolder,
    timestamp: new Date().toISOString(),
  });
}

function writeMemoryIpcFile(data: object): string {
  return writeIpcFile(MEMORY_DIR, data);
}

function emitMemorySaved(entry: {
  externalId: string;
  scope: string;
  scopeId: string;
  kind: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}): void {
  writeMemoryIpcFile({
    type: 'memory_saved',
    externalId: entry.externalId,
    scope: entry.scope,
    scopeId: entry.scopeId,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    tags: entry.tags,
    source: entry.source,
    pinned: entry.pinned,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function emitMemoryHit(data: {
  externalId: string;
  chatJid: string;
  groupFolder: string;
  sessionId?: string;
  round?: number;
  injectionLayer: string;
  reason: string;
  tokenCount: number;
}): void {
  writeMemoryIpcFile({
    type: 'memory_hit',
    ...data,
    ts: new Date().toISOString(),
  });
}

function emitSessionSummarySaved(data: {
  sessionId: string;
  groupFolder: string;
  chatJid: string;
  summaryType: string;
  content: string;
  tokenCount: number;
  roundStart: number;
  roundEnd: number;
}): void {
  writeMemoryIpcFile({
    type: 'session_summary_saved',
    ...data,
    createdAt: new Date().toISOString(),
  });
}

function buildSilentFlushPrompt(input: {
  previousSummary?: string;
  olderContext: string;
  anchorContext: string;
}): string {
  return [
    'You are performing a silent memory compaction pass.',
    'Your job is to extract only durable facts, preferences, rules, workflows, or project context that should persist beyond this transient session.',
    'You must act silently.',
    'Only emit tool calls.',
    'Do not emit conversational text.',
    'Do not explain what you are doing.',
    'If nothing is worth saving, emit no tool calls.',
    'Use save_memory for each durable item you decide to persist.',
    'Prefer concise, high-value memory entries over verbose notes.',
    '',
    input.previousSummary
      ? `<existing_session_summary>\n${input.previousSummary}\n</existing_session_summary>`
      : '',
    `<older_context_to_compact>\n${input.olderContext}\n</older_context_to_compact>`,
    `<recent_anchor_context>\n${input.anchorContext}\n</recent_anchor_context>`,
  ].filter(Boolean).join('\n\n');
}

async function runSilentMemoryFlush(options: {
  session: SessionState;
  olderMessages: ChatMessage[];
  anchorMessages: ChatMessage[];
  toolContext: ToolContext;
  providerConfig: ProviderConfig;
  roundNumber: number;
  systemPrompt: ChatMessage;
}): Promise<number> {
  const saveMemoryTool = getCoreToolDefinition('save_memory');
  const flushPrompt = buildSilentFlushPrompt({
    previousSummary: options.session.rollingSummary?.content,
    olderContext: summarizeMessagesForRollingContext(options.olderMessages),
    anchorContext: summarizeMessagesForRollingContext(options.anchorMessages.slice(0, 2)),
  });

  const flushMessages: ChatMessage[] = [
    options.systemPrompt,
    {
      role: 'user',
      content: flushPrompt,
    },
  ];

  const response = await callChatCompletion(
    options.providerConfig,
    flushMessages,
    [saveMemoryTool],
  );

  let executed = 0;
  for (const toolCall of response.toolCalls) {
    if (toolCall.function.name !== 'save_memory') {
      continue;
    }
    executed += 1;
    writeProgress({
      type: 'tool',
      stage: 'start',
      round: options.roundNumber,
      toolName: 'save_memory',
      toolCallId: toolCall.id,
      argsSummary: summarizeToolArgs(toolCall.function.arguments || '{}'),
      toolArgs: parseToolArgs(toolCall.function.arguments || '{}') || undefined,
      message: 'silent_memory_flush',
    }, options.session.sessionId);

    const startedAt = Date.now();
    options.toolContext.sessionId = options.session.sessionId;
    options.toolContext.currentRound = options.roundNumber;
    const toolResult = await executeToolCall(toolCall, options.toolContext);
    writeProgress({
      type: 'tool',
      stage: toolResult.success ? 'end' : 'error',
      round: options.roundNumber,
      toolName: 'save_memory',
      toolCallId: toolCall.id,
      durationMs: Date.now() - startedAt,
      success: toolResult.success,
      outputPreview: truncate(toolResult.output, 4000),
      output: truncate(toolResult.output, 4000),
      message: 'silent_memory_flush',
    }, options.session.sessionId);
  }

  if (!response.toolCalls.length && response.content.trim()) {
    writeProgress({
      type: 'lifecycle',
      stage: 'info',
      round: options.roundNumber,
      message: 'silent_memory_flush_returned_text_ignored',
      contentPreview: truncate(response.content, 1200),
    }, options.session.sessionId);
  }

  return executed;
}

function summarizeMessagesForRollingContext(messages: ChatMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      lines.push(
        `Tool ${message.name || 'unknown'} -> ${truncate(message.content || '', 400)}`,
      );
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      lines.push(
        `Assistant tool calls: ${message.tool_calls.map((call) => call.function.name).join(', ')}`,
      );
      continue;
    }
    const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${roleLabel}: ${truncate(message.content || '', 600)}`);
  }

  return lines.join('\n');
}

async function maybeUpdateRollingSummary(
  session: SessionState,
  containerInput: ContainerInput,
  toolContext: ToolContext,
  providerConfig: ProviderConfig,
  systemPrompt: ChatMessage,
  roundEnd: number,
): Promise<RollingSummaryUpdate | null> {
  if (getMessagesTokenCount(session.messages) <= ROLLING_SUMMARY_TRIGGER_TOKENS) {
    return null;
  }

  const tailMessages = Math.min(ROLLING_SUMMARY_TAIL_MESSAGES, session.messages.length);
  const olderMessages = session.messages.slice(0, Math.max(0, session.messages.length - tailMessages));
  if (olderMessages.length === 0) {
    return null;
  }

  const anchorMessages = session.messages.slice(
    Math.max(0, session.messages.length - tailMessages),
  );
  const removedMessageCount = olderMessages.length;
  const previousSummary = session.rollingSummary?.content?.trim();
  const olderSummary = summarizeMessagesForRollingContext(olderMessages);
  const anchorSummary = summarizeMessagesForRollingContext(anchorMessages.slice(0, 2));
  const parts = [
    previousSummary ? `Previous summary:\n${previousSummary}` : null,
    olderSummary ? `Compressed older context:\n${olderSummary}` : null,
    anchorSummary ? `Anchor to recent context:\n${anchorSummary}` : null,
  ].filter((part): part is string => !!part);

  if (parts.length === 0) {
    return null;
  }

  let savedCount = 0;
  try {
    savedCount = await runSilentMemoryFlush({
      session,
      olderMessages,
      anchorMessages,
      toolContext,
      providerConfig,
      roundNumber: roundEnd,
      systemPrompt,
    });
  } catch (err) {
    writeProgress({
      type: 'lifecycle',
      stage: 'error',
      round: roundEnd,
      message: 'silent_memory_flush_failed',
      contentPreview: truncate(
        err instanceof Error ? err.message : String(err),
        1200,
      ),
    }, session.sessionId);
  }

  const content = truncate(parts.join('\n\n'), 12_000);
  const tokenCount = estimateTokenCount(content);
  const priorRoundStart = session.rollingSummary?.roundStart ?? 1;
  session.rollingSummary = {
    content,
    tokenCount,
    roundStart: priorRoundStart,
    roundEnd,
    updatedAt: new Date().toISOString(),
  };

  emitSessionSummarySaved({
    sessionId: session.sessionId,
    groupFolder: containerInput.groupFolder,
    chatJid: containerInput.chatJid,
    summaryType: 'rolling',
    content,
    tokenCount,
    roundStart: session.rollingSummary.roundStart,
    roundEnd,
  });
  session.messages = anchorMessages;

  writeProgress({
    type: 'context',
    stage: 'info',
    round: roundEnd,
    message: 'silent_memory_flush_completed',
    toolCalls: savedCount,
    contentPreview: `saved_memories=${savedCount} removed_messages=${removedMessageCount} retained_messages=${anchorMessages.length}`,
  }, session.sessionId);

  return {
    summary: session.rollingSummary,
    removedMessageCount,
    retainedMessageCount: anchorMessages.length,
  };
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

  return sanitizeMessagesForProvider(trimmed);
}

function sanitizeMessagesForProvider(messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = [];
  const availableToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      const normalizedToolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.filter((toolCall) =>
          !!toolCall
          && typeof toolCall.id === 'string'
          && !!toolCall.id.trim()
          && !!toolCall.function
          && typeof toolCall.function.name === 'string'
          && !!toolCall.function.name.trim())
        : [];

      if (normalizedToolCalls.length > 0) {
        for (const toolCall of normalizedToolCalls) {
          availableToolCallIds.add(toolCall.id);
        }
        sanitized.push({
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : '',
          tool_calls: normalizedToolCalls,
        });
      } else {
        sanitized.push({
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : extractTextContent(message.content),
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      if (!message.tool_call_id || !availableToolCallIds.has(message.tool_call_id)) {
        continue;
      }
      sanitized.push({
        role: 'tool',
        tool_call_id: message.tool_call_id,
        name: message.name,
        content: typeof message.content === 'string' ? message.content : extractTextContent(message.content),
      });
      continue;
    }

    sanitized.push({
      ...message,
      content: typeof message.content === 'string' ? message.content : extractTextContent(message.content),
    });
  }

  return sanitized;
}

function getMessagesCharCount(messages: ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    0,
  );
}

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  // Practical heuristic for mixed English/CJK content when provider usage is unavailable.
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function getMessagesTokenCount(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    let text = message.content || '';
    if (message.tool_calls && message.tool_calls.length > 0) {
      text += JSON.stringify(message.tool_calls);
    }
    if (message.tool_call_id) {
      text += message.tool_call_id;
    }
    if (message.name) {
      text += message.name;
    }
    total += estimateTokenCount(text) + 4;
  }
  return total;
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

function pushUniqueText(target: string[], value: unknown): void {
  const text = extractTextContent(value).trim();
  if (!text) return;
  if (!target.includes(text)) {
    target.push(text);
  }
}

function isReasoningType(typeValue: unknown): boolean {
  if (typeof typeValue !== 'string') return false;
  const normalized = typeValue.toLowerCase();
  return (
    normalized.includes('reasoning')
    || normalized.includes('thinking')
    || normalized.includes('analysis')
  );
}

function extractContentParts(content: unknown): { textParts: string[]; reasoningParts: string[] } {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  if (!Array.isArray(content)) {
    pushUniqueText(textParts, content);
    return { textParts, reasoningParts };
  }

  for (const part of content) {
    if (typeof part === 'string') {
      pushUniqueText(textParts, part);
      continue;
    }

    if (!part || typeof part !== 'object') {
      continue;
    }

    const record = part as Record<string, unknown>;
    const bucket = isReasoningType(record.type) ? reasoningParts : textParts;

    pushUniqueText(bucket, record.text);
    pushUniqueText(bucket, record.content);
    pushUniqueText(bucket, record.output_text);
    pushUniqueText(bucket, record.value);

    if (!isReasoningType(record.type)) {
      pushUniqueText(reasoningParts, record.reasoning);
      pushUniqueText(reasoningParts, record.reasoning_content);
      pushUniqueText(reasoningParts, record.thinking);
      pushUniqueText(reasoningParts, record.analysis);
    }
  }

  return { textParts, reasoningParts };
}

function extractProviderResponse(
  choice: NonNullable<ChatCompletionResponse['choices']>[number] | undefined,
): {
  content: string;
  reasoning: string;
  contentSource: string;
  reasoningSource: string;
  toolCalls: ToolCall[];
} {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const contentSources: string[] = [];
  const reasoningSources: string[] = [];
  const message = choice?.message;

  const addContent = (source: string, value: unknown): void => {
    const before = contentParts.length;
    pushUniqueText(contentParts, value);
    if (contentParts.length > before) {
      contentSources.push(source);
    }
  };

  const addReasoning = (source: string, value: unknown): void => {
    const before = reasoningParts.length;
    pushUniqueText(reasoningParts, value);
    if (reasoningParts.length > before) {
      reasoningSources.push(source);
    }
  };

  if (message) {
    if (Array.isArray(message.content)) {
      const { textParts, reasoningParts: contentReasoningParts } = extractContentParts(message.content);
      for (const text of textParts) pushUniqueText(contentParts, text);
      for (const text of contentReasoningParts) pushUniqueText(reasoningParts, text);
      if (textParts.length > 0) contentSources.push('message.content[]');
      if (contentReasoningParts.length > 0) reasoningSources.push('message.content[]');
    } else {
      addContent('message.content', message.content);
    }

    addContent('message.text', message.text);
    addContent('message.output_text', message.output_text);
    addReasoning('message.reasoning', message.reasoning);
    addReasoning('message.reasoning_content', message.reasoning_content);
    addReasoning('message.thinking', message.thinking);
    addReasoning('message.analysis', message.analysis);
  }

  addReasoning('choice.reasoning', choice?.reasoning);
  addReasoning('choice.reasoning_content', choice?.reasoning_content);
  addReasoning('choice.thinking', choice?.thinking);
  addContent('choice.text', choice?.text);

  return {
    content: contentParts.join('\n\n').trim(),
    reasoning: reasoningParts.join('\n\n').trim(),
    contentSource: contentSources.join(', '),
    reasoningSource: reasoningSources.join(', '),
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
  };
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

function mimeFromImagePath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    default:
      return null;
  }
}

function normalizeImageMime(rawMime: string | undefined): string | null {
  if (!rawMime) return null;
  const mime = rawMime.split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) return null;
  return mime;
}

function extractInlineImageDescriptors(text: string): Array<{
  filePath: string;
  declaredMime?: string;
}> {
  const descriptors: Array<{ filePath: string; declaredMime?: string }> = [];
  const seen = new Set<string>();
  const lines = text.split('\n');

  for (const line of lines) {
    if (!/\[image/i.test(line)) continue;
    const pathMatch = line.match(/saved=(\/workspace\/group\/[^\s;]+)/i);
    if (!pathMatch) continue;
    const filePath = pathMatch[1];
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const typeMatch = line.match(/type=([^;]+)/i);
    descriptors.push({
      filePath,
      declaredMime: typeMatch?.[1]?.trim(),
    });
  }

  return descriptors;
}

function buildProviderUserContent(
  rawContent: string,
  options: {
    allowImages: boolean;
    disableReason?: string;
  },
): {
  content: string | ProviderContentPart[];
  requested: number;
  attached: number;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!rawContent.includes('/workspace/group/')) {
    return {
      content: rawContent,
      requested: 0,
      attached: 0,
      warnings,
    };
  }

  const imageDescriptors = extractInlineImageDescriptors(rawContent);
  if (imageDescriptors.length === 0) {
    return {
      content: rawContent,
      requested: 0,
      attached: 0,
      warnings,
    };
  }

  if (!options.allowImages) {
    const reason = options.disableReason || 'image input disabled';
    warnings.push(
      `Image inputs detected but not attached (${reason}).`,
    );
    return {
      content: rawContent,
      requested: imageDescriptors.length,
      attached: 0,
      warnings,
    };
  }

  const parts: ProviderContentPart[] = [
    { type: 'text', text: rawContent },
  ];
  let attached = 0;

  for (const descriptor of imageDescriptors) {
    if (attached >= INLINE_IMAGE_MAX_COUNT) {
      warnings.push(
        `image count exceeded limit (${INLINE_IMAGE_MAX_COUNT}); skipped: ${descriptor.filePath}`,
      );
      continue;
    }

    const filePath = descriptor.filePath;
    if (!filePath.startsWith('/workspace/group/')) {
      warnings.push(`path outside workspace: ${filePath}`);
      continue;
    }
    if (!fs.existsSync(filePath)) {
      warnings.push(`file missing: ${filePath}`);
      continue;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      warnings.push(`not a file: ${filePath}`);
      continue;
    }
    if (stat.size > INLINE_IMAGE_MAX_BYTES) {
      warnings.push(
        `file too large (${stat.size} bytes > ${INLINE_IMAGE_MAX_BYTES}): ${filePath}`,
      );
      continue;
    }

    const mime = normalizeImageMime(descriptor.declaredMime) || mimeFromImagePath(filePath);
    if (!mime) {
      warnings.push(`unsupported image type: ${filePath}`);
      continue;
    }

    const buffer = fs.readFileSync(filePath);
    if (buffer.length > INLINE_IMAGE_MAX_BYTES) {
      warnings.push(
        `file too large after read (${buffer.length} bytes > ${INLINE_IMAGE_MAX_BYTES}): ${filePath}`,
      );
      continue;
    }

    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    parts.push({
      type: 'image_url',
      image_url: { url: dataUrl },
    });
    attached += 1;
  }

  if (attached === 0) {
    if (warnings.length > 0) {
      log(`No inline images attached to provider request: ${warnings.join(' | ')}`);
    }
    return {
      content: rawContent,
      requested: imageDescriptors.length,
      attached: 0,
      warnings,
    };
  }

  log(`Attached ${attached} inline image(s) to provider user content`);
  if (warnings.length > 0) {
    log(`Inline image attachment warnings: ${warnings.join(' | ')}`);
  }
  return {
    content: parts,
    requested: imageDescriptors.length,
    attached,
    warnings,
  };
}

function materializeMessagesForProvider(
  messages: ChatMessage[],
  options: {
    allowImages: boolean;
    disableReason?: string;
  },
): ProviderMessageMaterializationResult {
  let inlineImageRequested = 0;
  let inlineImageAttached = 0;
  const warnings: string[] = [];

  const providerMessages = messages.map((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') {
      return {
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
        name: message.name,
      };
    }

    const converted = buildProviderUserContent(message.content, options);
    inlineImageRequested += converted.requested;
    inlineImageAttached += converted.attached;
    warnings.push(...converted.warnings);

    return {
      role: message.role,
      content: converted.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
      name: message.name,
    };
  });

  return {
    messages: providerMessages,
    inlineImageRequested,
    inlineImageAttached,
    warnings,
  };
}

function buildSystemPrompt(containerInput: ContainerInput): string {
  const fragments = [
    [
      'You are Bio, an AI biology research assistant running inside an isolated container.',
      'Prefer doing real analysis with tools over giving purely theoretical answers.',
      'Use bash for BLAST, minimap2, BWA, FastQC, PyMOL, Python scripts, and network calls.',
      'For biomedical literature retrieval, use search_pubmed first.',
      'Use read_file/write_file/edit_file/list_files/grep_files for direct workspace access.',
      'If a relevant skill is available from /home/node/.claude/skills, invoke the skill tool before continuing with normal tools.',
      'Use send_message for progress updates during long jobs.',
      'Use send_image after generating plots or structure renders.',
      'When calling save_memory, prefer scope="group" by default. Only use scope="global" or scope="project" if that scope is clearly writable in the current runtime.',
      'Keep WhatsApp replies clean: no markdown headings, prefer short paragraphs or bullet lists.',
      'Tool results and user messages may include <system-reminder> tags. These tags contain internal reminders and are not part of the user request.',
      'If part of your output is internal reasoning, wrap it in <internal> tags.',
      'Legacy references to mcp__molclaw__send_message or mcp__molclaw__send_image map to send_message and send_image in this runtime.',
      'Your writable workspace is primarily /workspace/group. The main group can also modify /workspace/project.',
    ].join('\n'),
    ...loadPromptFragments(containerInput),
  ];

  return fragments.join('\n\n');
}

interface PromptMemoryBudgetConfig {
  pinnedTokens: number;
  recentTokens: number;
  matchedTokens: number;
  sessionSummaryTokens: number;
}

interface BudgetedMemorySelection {
  entries: MemoryEntry[];
  tokenCount: number;
}

function readBoundedIntegerConfig(
  containerInput: ContainerInput,
  keys: string[],
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readConfigValue(containerInput, keys);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function getPromptMemoryBudgetConfig(
  containerInput: ContainerInput,
): PromptMemoryBudgetConfig {
  return {
    pinnedTokens: readBoundedIntegerConfig(
      containerInput,
      ['MOLCLAW_DURABLE_MEMORY_PINNED_TOKENS'],
      1_000,
      200,
      6_000,
    ),
    recentTokens: readBoundedIntegerConfig(
      containerInput,
      ['MOLCLAW_DURABLE_MEMORY_RECENT_TOKENS'],
      800,
      200,
      6_000,
    ),
    matchedTokens: readBoundedIntegerConfig(
      containerInput,
      ['MOLCLAW_DURABLE_MEMORY_MATCHED_TOKENS'],
      1_400,
      200,
      8_000,
    ),
    sessionSummaryTokens: readBoundedIntegerConfig(
      containerInput,
      ['MOLCLAW_SESSION_SUMMARY_TOKENS'],
      2_000,
      200,
      8_000,
    ),
  };
}

function estimateMemoryEntryTokens(entry: MemoryEntry): number {
  return estimateTokenCount(
    [entry.title, entry.kind, entry.content].filter(Boolean).join('\n'),
  );
}

function fitMemoryEntriesToTokenBudget(
  entries: MemoryEntry[],
  tokenBudget: number,
): BudgetedMemorySelection {
  const selected: MemoryEntry[] = [];
  let tokenCount = 0;

  for (const entry of entries) {
    const entryTokens = estimateMemoryEntryTokens(entry);
    if (selected.length > 0 && tokenCount + entryTokens > tokenBudget) {
      continue;
    }
    selected.push(entry);
    tokenCount += entryTokens;
    if (tokenCount >= tokenBudget) {
      break;
    }
  }

  return {
    entries: selected,
    tokenCount,
  };
}

function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
): { content: string; tokenCount: number } {
  const normalized = text.trim();
  const tokenCount = estimateTokenCount(normalized);
  if (!normalized || tokenCount <= tokenBudget) {
    return {
      content: normalized,
      tokenCount,
    };
  }

  const maxChars = Math.max(400, tokenBudget * 4);
  const truncated = [
    normalized.slice(0, maxChars),
    `...[truncated to fit ${tokenBudget} tokens from ~${tokenCount} tokens]`,
  ].join('\n');
  return {
    content: truncated,
    tokenCount: estimateTokenCount(truncated),
  };
}

function summarizePromptForMemoryReason(prompt: string): string {
  const normalized = prompt
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return 'matched prompt keywords';
  }
  return `matched query: ${truncate(normalized, 180)}`;
}

function buildMemoryAwarePromptMessages(
  systemPrompt: ChatMessage,
  session: SessionState,
  toolContext: ToolContext,
  roundNumber: number,
): {
  providerMessages: ChatMessage[];
  pinnedMemoryCount: number;
  recentMemoryCount: number;
  matchedMemoryCount: number;
  pinnedMemoryTokenCount: number;
  recentMemoryTokenCount: number;
  matchedMemoryTokenCount: number;
  sessionSummaryTokenCount: number;
  hitIds: string[];
} {
  const recentUserPrompt = [...session.messages]
    .reverse()
    .find((message) => message.role === 'user' && typeof message.content === 'string')
    ?.content || '';
  const memoryReason = summarizePromptForMemoryReason(recentUserPrompt);
  const budgetConfig = getPromptMemoryBudgetConfig(toolContext.containerInput);
  const memorySelection = selectMemoryForPrompt(toolContext.memoryScopes, {
    query: recentUserPrompt,
    maxPinned: 6,
    maxRecent: 4,
    maxMatched: 6,
  });
  const pinnedSelection = fitMemoryEntriesToTokenBudget(
    memorySelection.pinned,
    budgetConfig.pinnedTokens,
  );
  const recentSelection = fitMemoryEntriesToTokenBudget(
    memorySelection.recent,
    budgetConfig.recentTokens,
  );
  const matchedSelection = fitMemoryEntriesToTokenBudget(
    memorySelection.matched,
    budgetConfig.matchedTokens,
  );

  const memoryMessages: ChatMessage[] = [];
  const hitIds: string[] = [];

  const pinnedBlock = renderMemoryContextBlock(
    'durable_memory_pinned',
    pinnedSelection.entries,
  );
  if (pinnedBlock) {
    memoryMessages.push({
      role: 'system',
      content: pinnedBlock,
    });
    for (const entry of pinnedSelection.entries) {
      hitIds.push(entry.id);
      emitMemoryHit({
        externalId: entry.id,
        chatJid: toolContext.containerInput.chatJid,
        groupFolder: toolContext.containerInput.groupFolder,
        sessionId: session.sessionId,
        round: roundNumber,
        injectionLayer: 'durable_pinned',
        reason: 'pinned durable memory',
        tokenCount: estimateTokenCount(entry.content),
      });
    }
  }

  const recentBlock = renderMemoryContextBlock(
    'durable_memory_recent',
    recentSelection.entries,
  );
  if (recentBlock) {
    memoryMessages.push({
      role: 'system',
      content: recentBlock,
    });
    for (const entry of recentSelection.entries) {
      hitIds.push(entry.id);
      emitMemoryHit({
        externalId: entry.id,
        chatJid: toolContext.containerInput.chatJid,
        groupFolder: toolContext.containerInput.groupFolder,
        sessionId: session.sessionId,
        round: roundNumber,
        injectionLayer: 'durable_recent',
        reason: 'recent durable memory',
        tokenCount: estimateTokenCount(entry.content),
      });
    }
  }

  const matchedBlock = renderMemoryContextBlock(
    'durable_memory_matches',
    matchedSelection.entries,
  );
  if (matchedBlock) {
    memoryMessages.push({
      role: 'system',
      content: matchedBlock,
    });
    for (const entry of matchedSelection.entries) {
      hitIds.push(entry.id);
      emitMemoryHit({
        externalId: entry.id,
        chatJid: toolContext.containerInput.chatJid,
        groupFolder: toolContext.containerInput.groupFolder,
        sessionId: session.sessionId,
        round: roundNumber,
        injectionLayer: 'durable_search',
        reason: memoryReason,
        tokenCount: estimateTokenCount(entry.content),
      });
    }
  }

  let sessionSummaryTokenCount = 0;
  if (session.rollingSummary?.content) {
    const summaryContent = truncateTextToTokenBudget(
      session.rollingSummary.content,
      budgetConfig.sessionSummaryTokens,
    );
    sessionSummaryTokenCount = summaryContent.tokenCount;
    memoryMessages.push({
      role: 'system',
      content: [
        '<current_session_summary>',
        `rounds: ${session.rollingSummary.roundStart}-${session.rollingSummary.roundEnd}`,
        summaryContent.content,
        '</current_session_summary>',
      ].join('\n'),
    });
  }

  return {
    providerMessages: [systemPrompt, ...memoryMessages],
    pinnedMemoryCount: pinnedSelection.entries.length,
    recentMemoryCount: recentSelection.entries.length,
    matchedMemoryCount: matchedSelection.entries.length,
    pinnedMemoryTokenCount: pinnedSelection.tokenCount,
    recentMemoryTokenCount: recentSelection.tokenCount,
    matchedMemoryTokenCount: matchedSelection.tokenCount,
    sessionSummaryTokenCount,
    hitIds,
  };
}

function isImageUnsupportedError(message: string): boolean {
  const normalized = message.toLowerCase();
  const imageHints = [
    'image_url',
    'image input',
    'multimodal',
    'vision',
    'unsupported image',
    'invalid content type image',
    'content part type',
  ];
  return imageHints.some((hint) => normalized.includes(hint));
}

async function callChatCompletion(
  providerConfig: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<{
  content: string;
  reasoning: string;
  contentSource: string;
  reasoningSource: string;
  toolCalls: ToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  inlineImageRequested: number;
  inlineImageAttached: number;
  inlineImageWarnings: string[];
}> {
  const initialMaterialized = materializeMessagesForProvider(messages, {
    allowImages: providerConfig.supportsImageInput !== false,
    disableReason:
      providerConfig.supportsImageInput === false
        ? providerConfig.imageSupportReason
        : undefined,
  });

  let providerMessages = initialMaterialized.messages;
  let inlineImageRequested = initialMaterialized.inlineImageRequested;
  let inlineImageAttached = initialMaterialized.inlineImageAttached;
  const inlineImageWarnings = [...initialMaterialized.warnings];

  const payload: Record<string, unknown> = {
    model: providerConfig.model,
    messages: providerMessages,
    tools,
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

  const sendRequest = async (
    requestPayload: Record<string, unknown>,
  ): Promise<{ response: globalThis.Response; raw: string; parsed: ChatCompletionResponse }> => {
    const response = await fetch(providerConfig.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload),
    });
    const raw = await response.text();
    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch (err) {
      throw new Error(`Provider returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${truncate(raw, 1200)}`);
    }
    return { response, raw, parsed };
  };

  let { response, raw, parsed } = await sendRequest(payload);
  if (!response.ok) {
    const providerErrorMessage = parsed.error?.message || raw;
    if (inlineImageAttached > 0 && isImageUnsupportedError(providerErrorMessage)) {
      inlineImageWarnings.push(
        `Provider rejected image input; retried with text-only request (${truncate(providerErrorMessage, 240)}).`,
      );
      const fallbackMaterialized = materializeMessagesForProvider(messages, {
        allowImages: false,
        disableReason: 'provider rejected image input',
      });
      providerMessages = fallbackMaterialized.messages;
      inlineImageRequested = fallbackMaterialized.inlineImageRequested;
      inlineImageAttached = fallbackMaterialized.inlineImageAttached;
      inlineImageWarnings.push(...fallbackMaterialized.warnings);

      payload.messages = providerMessages;
      const retry = await sendRequest(payload);
      response = retry.response;
      raw = retry.raw;
      parsed = retry.parsed;
    }
  }

  if (!response.ok) {
    const message = parsed.error?.message || raw;
    throw new Error(`Provider request failed (${response.status}): ${truncate(message, 1200)}`);
  }

  const choice = parsed.choices?.[0];
  if (!choice?.message) {
    throw new Error(`Provider returned no choices: ${truncate(raw, 1200)}`);
  }

  const extracted = extractProviderResponse(choice);

  return {
    content: extracted.content,
    reasoning: extracted.reasoning,
    contentSource: extracted.contentSource,
    reasoningSource: extracted.reasoningSource,
    toolCalls: extracted.toolCalls,
    usage: parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens,
          completionTokens:
            parsed.usage.completion_tokens ?? parsed.usage.output_tokens,
          totalTokens: parsed.usage.total_tokens,
        }
      : undefined,
    inlineImageRequested,
    inlineImageAttached,
    inlineImageWarnings,
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

function getToolOutputLimit(toolName: string): number {
  return isSkillToolName(toolName)
    ? MAX_SKILL_TOOL_OUTPUT_CHARS
    : MAX_TOOL_OUTPUT_CHARS;
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

  async load_claude_skill(args, context) {
    const skillName = ensureString(args.skill_name, 'skill_name');
    return TOOL_EXECUTORS.skill({ skill: skillName }, context);
  },

  async skill(args, context) {
    const skillName = ensureString(args.skill, 'skill');
    const skill = findClaudeSkill(context.claudeSkillRegistry, skillName);
    if (!skill) {
      const parseErrors = context.claudeSkillRegistry.parseErrors
        .filter((entry) => entry.filePath.toLowerCase().includes(skillName.toLowerCase()))
        .map((entry) => `${entry.filePath}: ${entry.message}`);
      const errorSuffix = parseErrors.length > 0
        ? `\nParse errors:\n${parseErrors.join('\n')}`
        : '';
      throw new Error(`Skill not found in /home/node/.claude/skills: ${skillName}${errorSuffix}`);
    }
    const invocationHint =
      context.claudeSkillInvocationHints.get(skill.frontmatter.name)
      || (skill.frontmatter.aliases || [])
        .map((alias) => context.claudeSkillInvocationHints.get(alias))
        .find(Boolean);
    return [
      renderClaudeSkillInvocationHint(invocationHint),
      renderClaudeSkillLoadedReminder(skill),
      renderClaudeSkillForContext(skill),
    ]
      .filter(Boolean)
      .join('\n');
  },

  async search_pubmed(args) {
    const query = ensureString(args.query, 'query');
    const maxResults = ensureInteger(args.max_results, 'max_results', 5, 1, 20);
    return searchPubMed(query, maxResults);
  },

  async save_memory(args, context) {
    const title = ensureString(args.title, 'title');
    const content = ensureString(args.content, 'content');
    const kind = ensureString(args.kind, 'kind');
    const requestedScope = typeof args.scope === 'string'
      ? ensureEnumValue(
        args.scope,
        'scope',
        ['group', 'global', 'project'] as const,
      ) as MemoryScopeDescriptor['scope']
      : undefined;
    const tags = ensureStringArray(args.tags, 'tags');
    const pinned = ensureBoolean(args.pinned);
    const source = typeof args.source === 'string'
      ? ensureString(args.source, 'source')
      : undefined;

    const writableScopes = context.memoryScopes
      .filter((entry) => entry.writable)
      .map((entry) => entry.scope);
    let effectiveScope = requestedScope;
    let scopeNotice: string | null = null;

    if (requestedScope && !writableScopes.includes(requestedScope)) {
      if (writableScopes.includes('group')) {
        effectiveScope = 'group';
        scopeNotice = `Requested scope ${requestedScope} is not writable in this runtime; saved to group instead.`;
      } else {
        throw new Error(
          `Memory scope is not writable: ${requestedScope}. Writable scopes: ${writableScopes.join(', ') || '(none)'}`,
        );
      }
    }

    const saved = saveMemoryEntry(context.memoryScopes, {
      title,
      content,
      kind,
      scope: effectiveScope,
      tags,
      pinned,
      source,
    });
    emitMemorySaved({
      externalId: saved.entry.id,
      scope: saved.entry.scope,
      scopeId: saved.entry.scopeId,
      kind: saved.entry.kind,
      title: saved.entry.title,
      content: saved.entry.content,
      tags: saved.entry.tags,
      source: saved.entry.source,
      pinned: saved.entry.pinned,
      createdAt: saved.entry.createdAt,
      updatedAt: saved.entry.updatedAt,
    });

    return [
      `Saved memory ${saved.entry.id}`,
      scopeNotice,
      requestedScope ? `requested_scope: ${requestedScope}` : null,
      `scope: ${saved.entry.scope} (${saved.entry.scopeId})`,
      `kind: ${saved.entry.kind}`,
      `title: ${saved.entry.title}`,
      saved.entry.tags.length > 0 ? `tags: ${saved.entry.tags.join(', ')}` : null,
      `pinned: ${saved.entry.pinned ? 'yes' : 'no'}`,
      `memory_file: ${saved.memoryFilePath}`,
      `daily_log: ${saved.dailyLogPath}`,
    ].filter((line): line is string => line !== null).join('\n');
  },

  async memory_search(args, context) {
    const query = ensureString(args.query, 'query');
    const scope = typeof args.scope === 'string'
      ? ensureEnumValue(
        args.scope,
        'scope',
        ['all', 'group', 'global', 'project'] as const,
      ) as MemorySearchScope
      : 'all';
    const limit = ensureInteger(args.limit, 'limit', 5, 1, 20);
    const results = searchMemoryEntries(context.memoryScopes, {
      query,
      scope,
      limit,
    });

    if (results.length === 0) {
      return `No memory matches found for query: ${query}`;
    }

    return [
      `Found ${results.length} memory match(es) for: ${query}`,
      '',
      ...results.flatMap((result, index) => [
        `${index + 1}. [${result.id}] ${result.title}`,
        `scope: ${result.scope} (${result.scopeId})`,
        `kind: ${result.kind}`,
        `score: ${result.score}`,
        `pinned: ${result.pinned ? 'yes' : 'no'}`,
        `updated_at: ${result.updatedAt}`,
        `preview: ${result.shortPreview}`,
        '',
      ]),
    ].join('\n').trim();
  },

  async memory_get(args, context) {
    const id = ensureString(args.id, 'id');
    const entry = getMemoryEntryById(context.memoryScopes, id);
    if (!entry) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    emitMemoryHit({
      externalId: entry.id,
      chatJid: context.containerInput.chatJid,
      groupFolder: context.containerInput.groupFolder,
      sessionId: context.sessionId,
      round: context.currentRound,
      injectionLayer: 'memory_get',
      reason: 'tool requested full durable memory entry',
      tokenCount: estimateMemoryEntryTokens(entry),
    });

    return [
      `id: ${entry.id}`,
      `title: ${entry.title}`,
      `scope: ${entry.scope} (${entry.scopeId})`,
      `kind: ${entry.kind}`,
      `source: ${entry.source}`,
      `pinned: ${entry.pinned ? 'yes' : 'no'}`,
      `created_at: ${entry.createdAt}`,
      `updated_at: ${entry.updatedAt}`,
      entry.tags.length > 0 ? `tags: ${entry.tags.join(', ')}` : null,
      `file: ${entry.filePath}`,
      '',
      'content:',
      entry.content,
    ].filter((line): line is string => line !== null).join('\n');
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
  const outputLimit = getToolOutputLimit(toolCall.function.name);
  if (!executor) {
    return serializeToolExecutionResult(
      toolCall.function.name,
      `Unknown tool: ${toolCall.function.name}`,
      false,
      outputLimit,
    );
  }

  let args: Record<string, unknown> = {};
  try {
    args = toolCall.function.arguments
      ? JSON.parse(toolCall.function.arguments) as Record<string, unknown>
      : {};
  } catch (err) {
    return serializeToolExecutionResult(
      toolCall.function.name,
      `Failed to parse tool arguments: ${err instanceof Error ? err.message : String(err)}`,
      false,
      outputLimit,
    );
  }

  try {
    const result = await executor(args, context);
    return serializeToolExecutionResult(
      toolCall.function.name,
      result,
      true,
      outputLimit,
    );
  } catch (err) {
    return serializeToolExecutionResult(
      toolCall.function.name,
      err instanceof Error ? err.message : String(err),
      false,
      outputLimit,
    );
  }
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  providerConfig: ProviderConfig,
): Promise<{ newSessionId: string; closedDuringQuery: boolean; result: string | null }> {
  const session = sessionId ? loadSession(sessionId) || createSession() : createSession();
  const claudeSkillManager = new ClaudeSkillManager('/home/node/.claude/skills');
  const initialSkillSync = claudeSkillManager.sync();
  const skillConformanceState = createSkillConformanceState();
  const toolContext = createToolContext(
    containerInput,
    initialSkillSync.registry,
  );
  let multimodalNoticeSent = false;
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
    toolContext.sessionId = session.sessionId;
    toolContext.currentRound = roundNumber;
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
    const trimmedMessages = trimMessages(session.messages);
    const skillSync = claudeSkillManager.sync();
    const claudeSkillRegistry = skillSync.registry;
    toolContext.claudeSkillRegistry = claudeSkillRegistry;
    const selectedClaudeSkillCandidates = claudeSkillManager.resolveExplicit(prompt);
    toolContext.claudeSkillInvocationHints = new Map(
      selectedClaudeSkillCandidates
        .filter((entry) => entry.invocationHint)
        .flatMap((entry) => {
          const pairs: Array<[string, ClaudeSkillInvocationHint]> = [
            [entry.skill.frontmatter.name, entry.invocationHint!],
          ];
          for (const alias of entry.skill.frontmatter.aliases || []) {
            pairs.push([alias, entry.invocationHint!]);
          }
          return pairs;
        }),
    );
    const availableClaudeSkills = claudeSkillManager.listSkillSummaries();
    const autoMaterializedSkills = buildAutoMaterializedSkillMessages(
      selectedClaudeSkillCandidates,
    );
    const dynamicTools = buildToolDefinitions(
      claudeSkillManager.buildToolDefinition(),
    );
    writeProgress({
      type: 'context',
      stage: 'info',
      round: roundNumber,
      message: 'claude_skills_selected',
      toolCalls: selectedClaudeSkillCandidates.length,
      toolCallNames: selectedClaudeSkillCandidates.map((entry) => entry.skill.frontmatter.name).join(', '),
      contentPreview: truncate(
        selectedClaudeSkillCandidates.length > 0
          ? selectedClaudeSkillCandidates
            .map((entry) =>
              `${entry.skill.frontmatter.name} reasons=${entry.reasons.join(', ') || 'none'}`,
            )
            .join('\n')
          : `(available skills: ${availableClaudeSkills.length}, no explicit skill invocation)`,
        2400,
      ),
      claudeSkillRuntime: {
        ...skillSync.runtime,
        availableSkillCount: availableClaudeSkills.length,
        explicitInvocationCount: selectedClaudeSkillCandidates.length,
      },
      claudeSkillTrace: selectedClaudeSkillCandidates.map((entry) => ({
        name: entry.skill.frontmatter.name,
        score: entry.score,
        reasons: entry.reasons,
        explicitlyRequested: entry.explicitlyRequested,
        invocationTrigger: entry.invocationHint?.trigger,
        invocationArgs: entry.invocationHint?.args,
        model: entry.skill.frontmatter.model,
        userInvocable: entry.skill.frontmatter.userInvocable,
        disableModelInvocation: entry.skill.frontmatter.disableModelInvocation,
      })),
    }, session.sessionId);
    if (autoMaterializedSkills.names.length > 0) {
      writeProgress({
        type: 'context',
        stage: 'info',
        round: roundNumber,
        message: 'claude_skills_materialized',
        toolCalls: autoMaterializedSkills.names.length,
        toolCallNames: autoMaterializedSkills.names.join(', '),
        contentPreview: truncate(
          autoMaterializedSkills.trace
            .map((entry) => `${entry.name} reasons=${entry.reasons.join(', ') || 'none'}`)
            .join('\n'),
          2400,
        ),
        claudeSkillRuntime: {
          ...skillSync.runtime,
          availableSkillCount: availableClaudeSkills.length,
          explicitInvocationCount: selectedClaudeSkillCandidates.length,
          materializedSkillCount: autoMaterializedSkills.names.length,
          materializedSkillNames: autoMaterializedSkills.names,
        },
      }, session.sessionId);
    }
    if (claudeSkillRegistry.parseErrors.length > 0) {
      writeProgress({
        type: 'context',
        stage: 'info',
        round: roundNumber,
        message: 'claude_skills_parse_errors',
        parseErrors: claudeSkillRegistry.parseErrors,
        claudeSkillRuntime: {
          ...skillSync.runtime,
          availableSkillCount: availableClaudeSkills.length,
          explicitInvocationCount: selectedClaudeSkillCandidates.length,
        },
        contentPreview: truncate(
          claudeSkillRegistry.parseErrors
            .map((entry) => `${entry.filePath}: ${entry.message}`)
            .join('\n'),
          2400,
        ),
      }, session.sessionId);
    }
    writeProgress({
      type: 'context',
      stage: 'info',
      round: roundNumber,
      model: providerConfig.model,
      historyMessageCount: session.messages.length,
      historyCharCount: getMessagesCharCount(session.messages),
      historyTokenCount: getMessagesTokenCount(session.messages),
      trimmedMessageCount: trimmedMessages.length,
      trimmedCharCount: getMessagesCharCount(trimmedMessages),
      trimmedTokenCount: getMessagesTokenCount(trimmedMessages),
    }, session.sessionId);

    const promptMemory = buildMemoryAwarePromptMessages(
      systemPrompt,
      session,
      toolContext,
      roundNumber,
    );
    writeProgress({
      type: 'context',
      stage: 'info',
      round: roundNumber,
      message: 'memory_context_assembled',
      memoryHitCount: promptMemory.hitIds.length,
      memoryHitIds: promptMemory.hitIds,
      pinnedMemoryCount: promptMemory.pinnedMemoryCount,
      recentMemoryCount: promptMemory.recentMemoryCount,
      matchedMemoryCount: promptMemory.matchedMemoryCount,
      durableMemoryTokenCount:
        promptMemory.pinnedMemoryTokenCount
        + promptMemory.recentMemoryTokenCount
        + promptMemory.matchedMemoryTokenCount,
      sessionSummaryTokenCount: promptMemory.sessionSummaryTokenCount,
      contentPreview: truncate(
        [
          `pinned=${promptMemory.pinnedMemoryCount}`,
          `recent=${promptMemory.recentMemoryCount}`,
          `matched=${promptMemory.matchedMemoryCount}`,
          `session_summary_tokens=${promptMemory.sessionSummaryTokenCount}`,
          promptMemory.hitIds.length > 0
            ? `memory_ids=${promptMemory.hitIds.join(', ')}`
            : 'memory_ids=(none)',
        ].join('\n'),
        2400,
      ),
    }, session.sessionId);
    writeProgress({
      type: 'provider',
      stage: 'start',
      round: roundNumber,
      model: providerConfig.model,
    }, session.sessionId);

    const providerStartedAt = Date.now();
    let response: {
      content: string;
      reasoning: string;
      contentSource: string;
      reasoningSource: string;
      toolCalls: ToolCall[];
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
      inlineImageRequested: number;
      inlineImageAttached: number;
      inlineImageWarnings: string[];
    };
    try {
      response = await callChatCompletion(
        providerConfig,
        [...promptMemory.providerMessages, ...autoMaterializedSkills.messages, ...trimmedMessages],
        dynamicTools,
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
    const content = response.content.trim();
    const reasoning = response.reasoning.trim();
    const completionText = `${content}\n${reasoning}`.trim();
    const reasoningTokenCount = estimateTokenCount(reasoning);
    const completionTokenCount =
      response.usage?.completionTokens ?? estimateTokenCount(completionText);
    const promptTokenCount =
      response.usage?.promptTokens ??
      getMessagesTokenCount([
        ...promptMemory.providerMessages,
        ...autoMaterializedSkills.messages,
        ...trimmedMessages,
      ]);
    const totalTokenCount =
      response.usage?.totalTokens ?? promptTokenCount + completionTokenCount;

    if (response.inlineImageWarnings.length > 0) {
      writeProgress({
        type: 'lifecycle',
        stage: 'info',
        message: 'multimodal_warning',
        contentPreview: truncate(response.inlineImageWarnings.join(' | '), 1200),
      }, session.sessionId);
    }

    const modelLikelyNotSupportingImage =
      providerConfig.supportsImageInput === false
      || response.inlineImageWarnings.some((warning) =>
        /provider rejected image input|not attached \((configured|inferred|unknown)/i.test(warning),
      );

    if (
      response.inlineImageRequested > 0
      && response.inlineImageAttached === 0
      && modelLikelyNotSupportingImage
      && !multimodalNoticeSent
    ) {
      const reason = providerConfig.supportsImageInput === false
        ? providerConfig.imageSupportReason
        : (response.inlineImageWarnings[0] || 'provider does not accept image input for this request');
      enqueueNoticeMessage(
        containerInput,
        `Notice: current model ${providerConfig.model} is not using image input (${reason}). I can still read the saved file paths with tools, or you can switch to a multimodal model.`,
      );
      multimodalNoticeSent = true;
    }

    writeProgress({
      type: 'provider',
      stage: 'end',
      round: roundNumber,
      model: providerConfig.model,
      durationMs: providerDurationMs,
      toolCalls: response.toolCalls.length,
      toolCallNames: response.toolCalls
        .map((call) => call.function.name)
        .join(', '),
      contentChars: content.length,
      contentTokenCount: completionTokenCount,
      reasoningChars: reasoning.length,
      reasoningTokenCount,
      promptTokenCount,
      completionTokenCount,
      totalTokenCount,
      contentPreview: truncate(content, 6000),
      reasoningPreview: truncate(reasoning, 6000),
      contentSource: response.contentSource,
      reasoningSource: response.reasoningSource,
    }, session.sessionId);

    const assistantContent = response.toolCalls.length > 0
      ? (response.content || '')
      : (response.content || response.reasoning || null);
    session.messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    });

    if (response.toolCalls.length === 0) {
      const finalText = (content || reasoning).trim();
      const finalSkillConformance = buildSkillConformanceSnapshot(
        skillConformanceState,
        true,
      );
      if (finalSkillConformance) {
        writeProgress({
          type: 'context',
          stage: 'info',
          round: roundNumber,
          message: 'claude_skills_conformance',
          contentPreview: buildSkillConformancePreview(finalSkillConformance),
          claudeSkillRuntime: {
            ...skillSync.runtime,
            availableSkillCount: availableClaudeSkills.length,
            explicitInvocationCount: selectedClaudeSkillCandidates.length,
          },
          claudeSkillConformance: finalSkillConformance,
        }, session.sessionId);
      }
      writeProgress({
        type: 'lifecycle',
        stage: 'info',
        message: 'final_response_ready',
        contentChars: finalText.length,
        contentTokenCount: completionTokenCount,
      }, session.sessionId);
      const updatedSummary = await maybeUpdateRollingSummary(
        session,
        containerInput,
        toolContext,
        providerConfig,
        systemPrompt,
        roundNumber,
      );
      if (updatedSummary) {
        writeProgress({
          type: 'context',
          stage: 'info',
          round: roundNumber,
          message: 'rolling_summary_updated',
          sessionSummaryTokenCount: updatedSummary.summary.tokenCount,
          contentPreview: truncate(
            [
              `removed_messages=${updatedSummary.removedMessageCount}`,
              `retained_messages=${updatedSummary.retainedMessageCount}`,
              updatedSummary.summary.content,
            ].join('\n'),
            2400,
          ),
        }, session.sessionId);
      }
      saveSession(session);
      writeConversationArchive(session);
      return {
        newSessionId: session.sessionId,
        closedDuringQuery: false,
        result: finalText || null,
      };
    }

    for (const toolCall of response.toolCalls) {
      log(`Executing tool ${toolCall.function.name}`);
      const parsedToolArgs = parseToolArgs(toolCall.function.arguments || '{}');
      writeProgress({
        type: 'tool',
        stage: 'start',
        round: roundNumber,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        argsSummary: summarizeToolArgs(toolCall.function.arguments || '{}'),
        toolArgs: parsedToolArgs || undefined,
      }, session.sessionId);

      const toolStartedAt = Date.now();
      const toolResult = await executeToolCall(toolCall, toolContext);
      const toolDurationMs = Date.now() - toolStartedAt;
      updateSkillConformanceFromTool(
        skillConformanceState,
        toolCall.function.name,
        parsedToolArgs || {},
        roundNumber,
        claudeSkillRegistry,
        toolResult.success,
      );
      writeProgress({
        type: 'tool',
        stage: toolResult.success ? 'end' : 'error',
        round: roundNumber,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        durationMs: toolDurationMs,
        success: toolResult.success,
        outputPreview: truncate(toolResult.output, 12000),
        output: truncate(toolResult.output, 12000),
      }, session.sessionId);

      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolResult.modelContent,
      });
    }

    const updatedSummary = await maybeUpdateRollingSummary(
      session,
      containerInput,
      toolContext,
      providerConfig,
      systemPrompt,
      roundNumber,
    );
    if (updatedSummary) {
      writeProgress({
        type: 'context',
        stage: 'info',
        round: roundNumber,
        message: 'rolling_summary_updated',
        sessionSummaryTokenCount: updatedSummary.summary.tokenCount,
        contentPreview: truncate(
          [
            `removed_messages=${updatedSummary.removedMessageCount}`,
            `retained_messages=${updatedSummary.retainedMessageCount}`,
            updatedSummary.summary.content,
          ].join('\n'),
          2400,
        ),
      }, session.sessionId);
    }

    const roundSkillConformance = buildSkillConformanceSnapshot(
      skillConformanceState,
      false,
    );
    if (roundSkillConformance) {
      writeProgress({
        type: 'context',
        stage: 'info',
        round: roundNumber,
        message: 'claude_skills_conformance',
        contentPreview: buildSkillConformancePreview(roundSkillConformance),
        claudeSkillRuntime: {
          ...skillSync.runtime,
          availableSkillCount: availableClaudeSkills.length,
          explicitInvocationCount: selectedClaudeSkillCandidates.length,
        },
        claudeSkillConformance: roundSkillConformance,
      }, session.sessionId);
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
    log(
      `Provider image-input support: ${
        providerConfig.supportsImageInput === null
          ? 'unknown'
          : providerConfig.supportsImageInput ? 'enabled' : 'disabled'
      } (${providerConfig.imageSupportReason})`,
    );
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
