import { execSync } from 'child_process';
import dns from 'node:dns';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DASHBOARD_ENABLED,
  DASHBOARD_HOST,
  DASHBOARD_PORT,
  DASHBOARD_TOKEN,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { readEnvFile } from './env.js';
import { DiscordChannel } from './channels/discord.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  configureGlobalFetchProxy,
  configureGlobalSocketProxy,
  getConfiguredProxyUrl,
  maskProxyUrl,
} from './proxy.js';
import {
  AgentProgressEvent,
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  clearGroupModelPreference,
  getAllChats,
  AgentEventInput,
  getAllGroupModelPreferences,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  clearSession,
  setRegisteredGroup,
  setRouterState,
  setSession,
  setGroupModelPreference,
  insertAgentEvent,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { publishAgentEvent } from './agent-events.js';
import { startDashboardServer, DashboardServerHandle } from './dashboard.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

dns.setDefaultResultOrder('ipv4first');

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let sessionResetVersions: Record<string, number> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let groupModelPreferences: Record<string, { provider: string; model: string }> =
  {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let runtimeEnv: Record<string, string> = {};

let whatsapp: WhatsAppChannel | null = null;
const channels: Channel[] = [];
const queue = new GroupQueue();
let dashboardServer: DashboardServerHandle | null = null;

function recordAgentEvent(event: AgentEventInput): void {
  const eventId = insertAgentEvent(event);
  publishAgentEvent({
    id: eventId,
    ts: event.ts,
    chatJid: event.chatJid,
    groupFolder: event.groupFolder,
    sessionId: event.sessionId,
    eventType: event.eventType,
    stage: event.stage,
    payload: event.payload,
  });
}

function summarizeProgress(progress?: AgentProgressEvent): string {
  if (!progress) return 'unknown progress event';

  if (progress.type === 'provider') {
    const round = progress.round ? ` round=${progress.round}` : '';
    const model = progress.model ? ` model=${progress.model}` : '';
    const duration = progress.durationMs !== undefined ? ` durationMs=${progress.durationMs}` : '';
    const toolCalls = progress.toolCalls !== undefined ? ` toolCalls=${progress.toolCalls}` : '';
    const promptTokens =
      progress.promptTokenCount !== undefined
        ? ` promptTokens=${progress.promptTokenCount}`
        : '';
    const completionTokens =
      progress.completionTokenCount !== undefined
        ? ` completionTokens=${progress.completionTokenCount}`
        : '';
    const totalTokens =
      progress.totalTokenCount !== undefined
        ? ` totalTokens=${progress.totalTokenCount}`
        : '';
    const reasoningChars =
      progress.reasoningChars !== undefined ? ` reasoningChars=${progress.reasoningChars}` : '';
    return `provider ${progress.stage}${round}${model}${duration}${toolCalls}${promptTokens}${completionTokens}${totalTokens}${reasoningChars}`;
  }

  if (progress.type === 'tool') {
    const round = progress.round ? ` round=${progress.round}` : '';
    const tool = progress.toolName ? ` tool=${progress.toolName}` : '';
    const duration = progress.durationMs !== undefined ? ` durationMs=${progress.durationMs}` : '';
    const success = progress.success !== undefined ? ` success=${progress.success}` : '';
    return `tool ${progress.stage}${round}${tool}${duration}${success}`;
  }

  if (progress.type === 'context') {
    const round = progress.round ? ` round=${progress.round}` : '';
    const historyMessages =
      progress.historyMessageCount !== undefined
        ? ` historyMessages=${progress.historyMessageCount}`
        : '';
    const historyTokens =
      progress.historyTokenCount !== undefined
        ? ` historyTokens=${progress.historyTokenCount}`
        : '';
    const trimmedMessages =
      progress.trimmedMessageCount !== undefined
        ? ` trimmedMessages=${progress.trimmedMessageCount}`
        : '';
    const trimmedTokens =
      progress.trimmedTokenCount !== undefined
        ? ` trimmedTokens=${progress.trimmedTokenCount}`
        : '';
    return `context ${progress.stage}${round}${historyMessages}${historyTokens}${trimmedMessages}${trimmedTokens}`;
  }

  return progress.message
    ? `lifecycle ${progress.stage} message=${progress.message}`
    : `lifecycle ${progress.stage}`;
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  groupModelPreferences = getAllGroupModelPreferences();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

interface SessionResetResult {
  ok: boolean;
  chatJid: string;
  groupFolder?: string;
  previousSessionId?: string;
  message: string;
}

interface ModelProviderOption {
  provider: string;
  label: string;
  models: string[];
  defaultModel: string;
}

interface ModelCatalog {
  defaultProvider: string;
  providers: ModelProviderOption[];
}

function parseModelList(raw?: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

function firstConfigValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getRuntimeEnvValue(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  const fallback = runtimeEnv[key];
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return undefined;
}

function buildModelCatalog(): ModelCatalog {
  const requestedDefault = firstConfigValue(
    getRuntimeEnvValue('DEFAULT_MODEL_PROVIDER'),
    getRuntimeEnvValue('MODEL_PROVIDER'),
  )?.toLowerCase();

  const providers: ModelProviderOption[] = [];

  const openRouterModel = firstConfigValue(
    getRuntimeEnvValue('OPENROUTER_MODEL'),
    getRuntimeEnvValue('OPENAI_COMPATIBLE_MODEL'),
    getRuntimeEnvValue('OPENAI_COMPAT_MODEL'),
    getRuntimeEnvValue('LLM_MODEL'),
    'openai/gpt-4.1-mini',
  ) || 'openai/gpt-4.1-mini';
  const openRouterModels = Array.from(
    new Set([
      ...parseModelList(getRuntimeEnvValue('OPENROUTER_MODELS')),
      openRouterModel,
    ]),
  );
  const hasOpenRouter =
    !!firstConfigValue(
      getRuntimeEnvValue('OPENROUTER_API_KEY'),
      getRuntimeEnvValue('OPENROUTER_BASE_URL'),
      getRuntimeEnvValue('OPENROUTER_MODEL'),
      getRuntimeEnvValue('OPENROUTER_MODELS'),
    );
  if (hasOpenRouter) {
    providers.push({
      provider: 'openrouter',
      label: 'OpenRouter',
      models: openRouterModels,
      defaultModel: openRouterModel,
    });
  }

  const compatModel = firstConfigValue(
    getRuntimeEnvValue('OPENAI_COMPATIBLE_MODEL'),
    getRuntimeEnvValue('OPENAI_COMPAT_MODEL'),
    getRuntimeEnvValue('LLM_MODEL'),
    'openapi/claude-4.5-sonnet',
  ) || 'openapi/claude-4.5-sonnet';
  const compatModels = Array.from(
    new Set([
      ...parseModelList(getRuntimeEnvValue('OPENAI_COMPATIBLE_MODELS')),
      ...parseModelList(getRuntimeEnvValue('OPENAI_COMPAT_MODELS')),
      ...parseModelList(getRuntimeEnvValue('LLM_MODELS')),
      compatModel,
    ]),
  );
  const hasCompat =
    !!firstConfigValue(
      getRuntimeEnvValue('OPENAI_COMPATIBLE_BASE_URL'),
      getRuntimeEnvValue('OPENAI_COMPAT_BASE_URL'),
      getRuntimeEnvValue('LLM_BASE_URL'),
      getRuntimeEnvValue('OPENAI_COMPATIBLE_MODEL'),
      getRuntimeEnvValue('OPENAI_COMPAT_MODEL'),
      getRuntimeEnvValue('LLM_MODEL'),
    );
  if (hasCompat || providers.length === 0) {
    providers.push({
      provider: 'openai-compatible',
      label: 'OpenAI-Compatible',
      models: compatModels,
      defaultModel: compatModel,
    });
  }

  const defaultProvider = providers.some((p) => p.provider === requestedDefault)
    ? (requestedDefault as string)
    : providers[0]?.provider || 'openai-compatible';

  return {
    defaultProvider,
    providers,
  };
}

function getEffectiveModelSelection(groupFolder: string): {
  provider: string;
  model: string;
  source: 'default' | 'override';
} {
  const catalog = buildModelCatalog();
  const override = groupModelPreferences[groupFolder];
  if (override) {
    const providerOption = catalog.providers.find(
      (p) => p.provider === override.provider,
    );
    if (providerOption) {
      const fallbackModel = providerOption.defaultModel;
      const isKnownModel =
        providerOption.models.length === 0
        || providerOption.models.includes(override.model);
      return {
        provider: override.provider,
        model: isKnownModel ? override.model : fallbackModel,
        source: 'override',
      };
    }
  }
  const provider =
    catalog.providers.find((p) => p.provider === catalog.defaultProvider)
    || catalog.providers[0];
  return {
    provider: provider?.provider || catalog.defaultProvider,
    model: provider?.defaultModel || '',
    source: 'default',
  };
}

function getCurrentSelectionText(groupFolder: string): string {
  const effective = getEffectiveModelSelection(groupFolder);
  return `${effective.provider} / ${effective.model || '(unset)'} (${effective.source})`;
}

function clearInvalidModelPreference(groupFolder: string): void {
  const catalog = buildModelCatalog();
  const override = groupModelPreferences[groupFolder];
  if (!override) return;
  const providerOption = catalog.providers.find(
    (p) => p.provider === override.provider,
  );
  if (!providerOption) {
    delete groupModelPreferences[groupFolder];
    clearGroupModelPreference(groupFolder);
    return;
  }
  if (
    providerOption.models.length > 0
    && !providerOption.models.includes(override.model)
  ) {
    groupModelPreferences[groupFolder] = {
      provider: override.provider,
      model: providerOption.defaultModel,
    };
    setGroupModelPreference(groupFolder, groupModelPreferences[groupFolder]);
  }
}

function getEffectiveModelSelectionWithCleanup(groupFolder: string): {
  provider: string;
  model: string;
  source: 'default' | 'override';
} {
  clearInvalidModelPreference(groupFolder);
  return getEffectiveModelSelection(groupFolder);
}

function renderModelCatalogText(groupFolder: string): string {
  const catalog = buildModelCatalog();
  if (catalog.providers.length === 0) {
    return 'No available model providers found. Please configure provider env vars first.';
  }
  const effective = getEffectiveModelSelectionWithCleanup(groupFolder);
  const lines: string[] = [];
  lines.push('Available model providers and models:');
  lines.push('');
  for (const provider of catalog.providers) {
    const isDefault = provider.provider === catalog.defaultProvider;
    const isActive = provider.provider === effective.provider;
    lines.push(
      `- ${provider.label} (${provider.provider})${isDefault ? ' [default]' : ''}${isActive ? ' [active]' : ''}`,
    );
    if (provider.models.length > 0) {
      const preview = provider.models.slice(0, 12).join(', ');
      const suffix = provider.models.length > 12
        ? ` ...(+${provider.models.length - 12})`
        : '';
      lines.push(`  models: ${preview}${suffix}`);
    } else {
      lines.push('  models: (none configured)');
    }
  }
  lines.push('');
  lines.push(
    `Current for this chat: ${getCurrentSelectionText(groupFolder)}`,
  );
  lines.push('Use: /models action:set provider:<id> model:<model>');
  return lines.join('\n');
}

function setModelSelectionForChat(
  chatJid: string,
  provider: string,
  model?: string,
): { ok: boolean; message: string } {
  const group = registeredGroups[chatJid];
  if (!group) {
    return { ok: false, message: `Group ${chatJid} is not registered.` };
  }
  const normalizedProvider = provider.trim().toLowerCase();
  const catalog = buildModelCatalog();
  const providerOption = catalog.providers.find(
    (p) => p.provider === normalizedProvider,
  );
  if (!providerOption) {
    return {
      ok: false,
      message: `Unknown provider "${provider}". Run /models action:list to see options.`,
    };
  }

  const selectedModel = (model || '').trim() || providerOption.defaultModel;
  if (!selectedModel) {
    return {
      ok: false,
      message: `No model configured for provider ${normalizedProvider}.`,
    };
  }

  if (
    providerOption.models.length > 0
    && !providerOption.models.includes(selectedModel)
  ) {
    return {
      ok: false,
      message: `Model "${selectedModel}" is not in configured list for ${normalizedProvider}.`,
    };
  }

  groupModelPreferences[group.folder] = {
    provider: normalizedProvider,
    model: selectedModel,
  };
  setGroupModelPreference(group.folder, {
    provider: normalizedProvider,
    model: selectedModel,
  });

  logger.info(
    {
      chatJid,
      groupFolder: group.folder,
      provider: normalizedProvider,
      model: selectedModel,
    },
    'Updated model provider selection',
  );

  return {
    ok: true,
    message: `Updated model for this chat: ${normalizedProvider} / ${selectedModel}`,
  };
}

const NEW_SESSION_COMMANDS = new Set([
  'newsession',
  'new_session',
  'newchat',
  'reset',
  'resetsession',
  'reset_session',
]);

function parseSessionResetCommand(raw: string): boolean {
  let text = raw.trim();
  if (!text) return false;

  const triggerPrefix = `@${ASSISTANT_NAME}`;
  if (text.toLowerCase().startsWith(triggerPrefix.toLowerCase())) {
    text = text.slice(triggerPrefix.length).trim();
  }

  if (!text) {
    return false;
  }

  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 1) {
    return false;
  }

  const token = parts[0];
  const normalized = token.startsWith('/')
    ? token.slice(1).toLowerCase()
    : token.toLowerCase();
  return NEW_SESSION_COMMANDS.has(normalized);
}

function resetChatSession(chatJid: string, source: string): SessionResetResult {
  const group = registeredGroups[chatJid];
  if (!group) {
    return {
      ok: false,
      chatJid,
      message: `Group ${chatJid} is not registered.`,
    };
  }

  const previousSessionId = sessions[group.folder];
  if (previousSessionId) {
    delete sessions[group.folder];
  }
  clearSession(group.folder);
  sessionResetVersions[group.folder] = (sessionResetVersions[group.folder] || 0) + 1;

  queue.closeStdin(chatJid);

  const payload: Record<string, unknown> = {
    message: 'session_reset',
    source,
    previousSessionId: previousSessionId || null,
  };
  recordAgentEvent({
    ts: new Date().toISOString(),
    chatJid,
    groupFolder: group.folder,
    eventType: 'lifecycle',
    stage: 'info',
    payload,
  });

  logger.info(
    { chatJid, groupFolder: group.folder, source, previousSessionId: previousSessionId || null },
    'Session reset requested',
  );

  return {
    ok: true,
    chatJid,
    groupFolder: group.folder,
    previousSessionId,
    message: previousSessionId
      ? `Started a new session (previous: ${previousSessionId}).`
      : 'Started a new session.',
  };
}

function buildDashboardUrl(host: string, port: number, token?: string): string {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const base = `http://${displayHost}:${port}/`;
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' &&
        (c.jid.endsWith('@g.us') || c.jid.startsWith('dc:')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const latestMessage = missedMessages[missedMessages.length - 1];
  if (latestMessage && parseSessionResetCommand(latestMessage.content)) {
    const resetResult = resetChatSession(chatJid, 'chat_command');
    const ack = formatOutbound(channel, resetResult.message);
    if (ack) {
      await channel.sendMessage(chatJid, ack);
    }
    lastAgentTimestamp[chatJid] = latestMessage.timestamp;
    saveState();
    return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );
  recordAgentEvent({
    ts: new Date().toISOString(),
    chatJid,
    groupFolder: group.folder,
    sessionId: sessions[group.folder],
    eventType: 'message',
    stage: 'start',
    payload: {
      messageCount: missedMessages.length,
      requiresTrigger: group.requiresTrigger !== false,
    },
  });

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.status === 'progress') {
      recordAgentEvent({
        ts: result.progress?.timestamp || new Date().toISOString(),
        chatJid,
        groupFolder: group.folder,
        sessionId: result.newSessionId || sessions[group.folder],
        eventType: result.progress?.type || 'lifecycle',
        stage: result.progress?.stage || 'info',
        payload: result.progress
          ? { ...result.progress }
          : { message: 'missing progress payload' },
      });
      logger.info(
        {
          group: group.name,
          chatJid,
          progress: result.progress,
        },
        `Agent progress: ${summarizeProgress(result.progress)}`,
      );
      return;
    }

    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      recordAgentEvent({
        ts: new Date().toISOString(),
        chatJid,
        groupFolder: group.folder,
        sessionId: result.newSessionId || sessions[group.folder],
        eventType: 'final_output',
        stage: 'info',
        payload: {
          length: raw.length,
          tokenCountEstimate: Math.max(1, Math.ceil(raw.length / 4)),
          text: raw.slice(0, 12000),
          preview: raw.slice(0, 300),
        },
      });
      const text = formatOutbound(channel, raw);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      recordAgentEvent({
        ts: new Date().toISOString(),
        chatJid,
        groupFolder: group.folder,
        sessionId: result.newSessionId || sessions[group.folder],
        eventType: 'error',
        stage: 'error',
        payload: {
          error: result.error || 'Unknown error',
        },
      });
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];
  const runSessionVersion = sessionResetVersions[group.folder] || 0;
  const modelSelection = getEffectiveModelSelectionWithCleanup(group.folder);
  logger.debug(
    {
      group: group.name,
      provider: modelSelection.provider,
      model: modelSelection.model,
      source: modelSelection.source,
    },
    'Using model selection for run',
  );

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if ((sessionResetVersions[group.folder] || 0) === runSessionVersion) {
            sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);
          } else {
            logger.info(
              {
                group: group.name,
                staleSessionId: output.newSessionId,
                runSessionVersion,
                currentSessionVersion: sessionResetVersions[group.folder] || 0,
              },
              'Ignored stale session update after reset',
            );
          }
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        providerOverride: {
          provider: modelSelection.provider,
          model: modelSelection.model,
        },
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if ((sessionResetVersions[group.folder] || 0) === runSessionVersion) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      } else {
        logger.info(
          {
            group: group.name,
            staleSessionId: output.newSessionId,
            runSessionVersion,
            currentSessionVersion: sessionResetVersions[group.folder] || 0,
          },
          'Ignored stale final session update after reset',
        );
      }
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`BioClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const latestPending = messagesToSend[messagesToSend.length - 1];
          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID in message loop');
            continue;
          }

          if (latestPending && parseSessionResetCommand(latestPending.content)) {
            const resetResult = resetChatSession(chatJid, 'chat_command');
            const ack = formatOutbound(channel, resetResult.message);
            if (ack) {
              await channel.sendMessage(chatJid, ack);
            }
            lastAgentTimestamp[chatJid] = latestPending.timestamp;
            saveState();
            continue;
          }

          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }

  // Kill and clean up orphaned BioClaw containers from previous runs
  try {
    const output = execSync('docker ps --filter "name=bioclaw-" --format "{{.Names}}"', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  let isShuttingDown = false;
  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | null> => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            logger.warn({ timeoutMs }, `${label} timed out`);
            resolve(null);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    if (dashboardServer) {
      try {
        await withTimeout(dashboardServer.close(), 3000, 'Dashboard shutdown');
      } catch (err) {
        logger.warn({ err }, 'Failed to stop dashboard server cleanly');
      }
      dashboardServer = null;
    }
    await withTimeout(queue.shutdown(10000), 3000, 'Queue shutdown');
    for (const ch of channels) {
      await withTimeout(ch.disconnect(), 3000, `Channel(${ch.name}) disconnect`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const env = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'WHATSAPP_ENABLED',
    'DEFAULT_MODEL_PROVIDER',
    'MODEL_PROVIDER',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_MODEL',
    'OPENROUTER_MODELS',
    'OPENAI_COMPATIBLE_API_KEY',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODEL',
    'OPENAI_COMPATIBLE_MODELS',
    'OPENAI_COMPAT_BASE_URL',
    'OPENAI_COMPAT_MODEL',
    'OPENAI_COMPAT_MODELS',
    'LLM_BASE_URL',
    'LLM_MODEL',
    'LLM_MODELS',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
    'DASHBOARD_ENABLED',
    'DASHBOARD_HOST',
    'DASHBOARD_PORT',
    'DASHBOARD_TOKEN',
  ]);
  runtimeEnv = { ...env };

  // Allow putting provider/proxy vars in `.env` (without exporting them in shell).
  // Provider/model discovery and proxy setup read from process.env at runtime.
  for (const key of [
    'DEFAULT_MODEL_PROVIDER',
    'MODEL_PROVIDER',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_MODEL',
    'OPENROUTER_MODELS',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OPENAI_COMPATIBLE_MODEL',
    'OPENAI_COMPATIBLE_MODELS',
    'OPENAI_COMPAT_BASE_URL',
    'OPENAI_COMPAT_MODEL',
    'OPENAI_COMPAT_MODELS',
    'LLM_BASE_URL',
    'LLM_MODEL',
    'LLM_MODELS',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
  ] as const) {
    if (!process.env[key] && env[key]) {
      process.env[key] = env[key];
    }
  }

  const proxyUrl = getConfiguredProxyUrl();
  if (proxyUrl) {
    logger.info({ proxy: maskProxyUrl(proxyUrl) }, 'Using proxy for outbound HTTP');
  }
  configureGlobalFetchProxy();
  configureGlobalSocketProxy();

  const whatsappEnabledRaw =
    process.env.WHATSAPP_ENABLED ?? env.WHATSAPP_ENABLED ?? 'true';
  const whatsappEnabled = whatsappEnabledRaw.toLowerCase() !== 'false';

  if (whatsappEnabled) {
    // Create WhatsApp channel
    whatsapp = new WhatsAppChannel({
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp) =>
        storeChatMetadata(chatJid, timestamp),
      registeredGroups: () => registeredGroups,
    });
    channels.push(whatsapp);

    // Connect — resolves when first connected
    await whatsapp.connect();
    logger.info('WhatsApp channel connected');
  } else {
    logger.info('WhatsApp disabled (WHATSAPP_ENABLED=false)');
  }

  // Optional: Discord channel (if configured)
  const discordToken = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
  if (discordToken) {
    const discord = new DiscordChannel(discordToken, {
      onMessage: (chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
      registerGroup,
      resetSession: (chatJid, source) => resetChatSession(chatJid, source),
      handleModelsCommand: ({ chatJid, action, provider, model }) => {
        const group = registeredGroups[chatJid];
        if (!group) {
          return { ok: false, message: `Group ${chatJid} is not registered.` };
        }

        if (action === 'set') {
          if (!provider) {
            return {
              ok: false,
              message: 'Missing provider. Usage: /models action:set provider:<id> model:<model>',
            };
          }
          return setModelSelectionForChat(chatJid, provider, model);
        }

        return {
          ok: true,
          message: renderModelCatalogText(group.folder),
        };
      },
    });
    channels.push(discord);
    await discord.connect();
    logger.info('Discord channel connected');
  } else {
    logger.info('Discord not configured (DISCORD_BOT_TOKEN missing)');
  }

  if (channels.length === 0) {
    logger.fatal(
      'No channels connected. Set DISCORD_BOT_TOKEN and/or enable WhatsApp.',
    );
    process.exit(1);
  }

  const dashboardEnabledRaw =
    process.env.DASHBOARD_ENABLED ??
    env.DASHBOARD_ENABLED ??
    String(DASHBOARD_ENABLED);
  const dashboardEnabled = dashboardEnabledRaw.toLowerCase() === 'true';
  const dashboardHost =
    process.env.DASHBOARD_HOST || env.DASHBOARD_HOST || DASHBOARD_HOST;
  const dashboardPort = Number.parseInt(
    process.env.DASHBOARD_PORT || env.DASHBOARD_PORT || String(DASHBOARD_PORT),
    10,
  );
  const dashboardToken =
    process.env.DASHBOARD_TOKEN || env.DASHBOARD_TOKEN || DASHBOARD_TOKEN;

  if (dashboardEnabled) {
    const effectiveDashboardPort = Number.isFinite(dashboardPort)
      ? dashboardPort
      : DASHBOARD_PORT;
    dashboardServer = startDashboardServer(
      {
        host: dashboardHost,
        port: effectiveDashboardPort,
        token: dashboardToken || undefined,
      },
      {
        getQueueSnapshot: () => queue.getSnapshot(),
        resetSession: (chatJid) => resetChatSession(chatJid, 'dashboard'),
      },
    );
    const dashboardUrl = buildDashboardUrl(
      dashboardHost,
      effectiveDashboardPort,
      dashboardToken || undefined,
    );
    logger.info({ url: dashboardUrl }, 'Dashboard URL');
    // Plain console link for IDE terminals with click-to-open support.
    console.log(`Dashboard: ${dashboardUrl}`);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel for JID, cannot send message');
        return;
      }
      const text = formatOutbound(channel, rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    onAgentEvent: recordAgentEvent,
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel for JID, cannot send IPC message');
        return;
      }
      await channel.sendMessage(jid, text);
    },
    sendImage: async (jid, imagePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendImage) {
        logger.warn({ jid }, 'Channel does not support images');
        return;
      }
      await channel.sendImage(jid, imagePath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async (force) => {
      if (!whatsapp) {
        logger.warn(
          { force },
          'WhatsApp disabled/unavailable: syncGroupMetadata ignored',
        );
        return;
      }
      await whatsapp.syncGroupMetadata(force);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start BioClaw');
    process.exit(1);
  });
}
