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
  getAllChats,
  AgentEventInput,
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
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

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
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
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
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
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

  // Allow putting proxy vars in `.env` (without exporting them in the shell).
  // `proxy.ts` reads from process.env, and discord.js uses undici which
  // respects undici's global dispatcher.
  for (const key of [
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
