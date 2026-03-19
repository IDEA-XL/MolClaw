import fs from 'fs';
import path from 'node:path';

import type { Client, TextChannel } from 'discord.js';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  resetSession?: (
    jid: string,
    source: string,
  ) => {
    ok: boolean;
    message: string;
  };
  handleModelsCommand?: (params: {
    chatJid: string;
    action: 'list' | 'show' | 'set';
    provider?: string;
    model?: string;
  }) => {
    ok: boolean;
    message: string;
  };
}

const SESSION_RESET_SLASH_COMMANDS = [
  {
    name: 'newsession',
    description: 'Start a new MolClaw session for this chat',
  },
  {
    name: 'reset_session',
    description: 'Reset current MolClaw session for this chat',
  },
  {
    name: 'reset',
    description: 'Reset current MolClaw session for this chat',
  },
] as const;

const SESSION_RESET_COMMAND_NAME_SET: Set<string> = new Set(
  SESSION_RESET_SLASH_COMMANDS.map((cmd) => cmd.name),
);

const MODELS_SLASH_COMMAND = {
  name: 'models',
  description: 'List or set provider/model for this chat',
  options: [
    {
      type: 3,
      name: 'action',
      description: 'list/show/set',
      required: false,
      choices: [
        { name: 'list', value: 'list' },
        { name: 'show', value: 'show' },
        { name: 'set', value: 'set' },
      ],
    },
    {
      type: 3,
      name: 'provider',
      description: 'Provider id (e.g., openrouter)',
      required: false,
    },
    {
      type: 3,
      name: 'model',
      description: 'Model id',
      required: false,
    },
  ],
} as const;

const DEFAULT_DISCORD_ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024; // 30MB
const DISCORD_ATTACHMENT_MAX_BYTES = Math.max(
  1,
  parseInt(
    process.env.DISCORD_ATTACHMENT_MAX_BYTES ||
      `${DEFAULT_DISCORD_ATTACHMENT_MAX_BYTES}`,
    10,
  ) || DEFAULT_DISCORD_ATTACHMENT_MAX_BYTES,
);
const DEFAULT_DISCORD_ATTACHMENT_TIMEOUT_MS = 15000;
const DISCORD_ATTACHMENT_TIMEOUT_MS = Math.max(
  1000,
  parseInt(
    process.env.DISCORD_ATTACHMENT_TIMEOUT_MS ||
      `${DEFAULT_DISCORD_ATTACHMENT_TIMEOUT_MS}`,
    10,
  ) || DEFAULT_DISCORD_ATTACHMENT_TIMEOUT_MS,
);

function enableDiscordGlobalWebSocketPath(): void {
  // @discordjs/ws picks between `ws` and `globalThis.WebSocket` at module
  // initialization time. In Node it defaults to `ws`, which doesn't honor
  // undici's global dispatcher proxy setup.
  //
  // We set a lightweight compatibility flag before importing discord.js so
  // @discordjs/ws selects the global WebSocket path instead.
  const versions = process.versions as Record<string, string | undefined>;
  if (!versions.bun) {
    versions.bun = 'proxy-shim';
    logger.debug('Enabled Discord WebSocket proxy compatibility shim');
  }
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private formatBytes(bytes: number): string {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0B';
    if (value < 1024) return `${value}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  }

  private attachmentKind(contentType: string): string {
    if (contentType.startsWith('image/')) return 'Image';
    if (contentType.startsWith('video/')) return 'Video';
    if (contentType.startsWith('audio/')) return 'Audio';
    return 'File';
  }

  private inferExtension(contentType: string): string {
    const lower = contentType.toLowerCase();
    if (lower.startsWith('image/')) {
      if (lower.includes('png')) return '.png';
      if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg';
      if (lower.includes('webp')) return '.webp';
      if (lower.includes('gif')) return '.gif';
      if (lower.includes('bmp')) return '.bmp';
    }
    if (lower.startsWith('text/csv')) return '.csv';
    if (lower.startsWith('application/json')) return '.json';
    if (lower.startsWith('text/plain')) return '.txt';
    return '';
  }

  private sanitizeFilename(rawName: string, fallbackBase: string): string {
    const trimmed = rawName.trim();
    const extRaw = path.extname(trimmed).slice(0, 16);
    const ext = extRaw.replace(/[^a-zA-Z0-9.]/g, '');
    const baseRaw = extRaw ? trimmed.slice(0, -extRaw.length) : trimmed;
    const base = baseRaw
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+/, '')
      .replace(/_+$/, '')
      .slice(0, 64);
    const safeBase = base || fallbackBase;
    return `${safeBase}${ext}`;
  }

  private async materializeDiscordAttachments(params: {
    chatJid: string;
    groupFolder: string;
    messageId: string;
    timestamp: string;
    attachments: Array<{
      name?: string | null;
      size?: number;
      contentType?: string | null;
      url?: string;
      proxyURL?: string;
    }>;
  }): Promise<string[]> {
    const { chatJid, groupFolder, messageId, timestamp, attachments } = params;
    if (attachments.length === 0) return [];

    const day = timestamp.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const relativeDir = path.posix.join('inbox', 'discord', day);
    const absoluteDir = path.join(GROUPS_DIR, groupFolder, ...relativeDir.split('/'));
    fs.mkdirSync(absoluteDir, { recursive: true });

    const descriptions: string[] = [];
    let savedCount = 0;

    for (let i = 0; i < attachments.length; i += 1) {
      const attachment = attachments[i];
      const contentType = String(attachment.contentType || '').toLowerCase();
      const kind = this.attachmentKind(contentType);
      const declaredSize = Number(attachment.size || 0);
      const sourceUrl = String(attachment.url || attachment.proxyURL || '').trim();
      const fallbackName = `${kind.toLowerCase()}-${i + 1}${this.inferExtension(contentType)}`;
      const originalName = (attachment.name || '').trim() || fallbackName;
      const safeName = this.sanitizeFilename(originalName, `attachment-${i + 1}`);
      const finalName = `${messageId}-${String(i + 1).padStart(2, '0')}-${safeName}`;
      const relativePath = path.posix.join(relativeDir, finalName);
      const absolutePath = path.join(absoluteDir, finalName);

      if (!sourceUrl) {
        descriptions.push(
          `[${kind} receive failed] name=${originalName}; error=missing attachment URL`,
        );
        continue;
      }

      if (declaredSize > DISCORD_ATTACHMENT_MAX_BYTES) {
        descriptions.push(
          `[${kind}] name=${originalName}; size=${this.formatBytes(declaredSize)}; skipped=too_large(limit=${this.formatBytes(DISCORD_ATTACHMENT_MAX_BYTES)})`,
        );
        continue;
      }

      let timeoutHandle: NodeJS.Timeout | null = null;
      try {
        const controller = new AbortController();
        timeoutHandle = setTimeout(() => {
          controller.abort();
        }, DISCORD_ATTACHMENT_TIMEOUT_MS);

        const response = await fetch(sourceUrl, {
          signal: controller.signal,
          redirect: 'follow',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const raw = new Uint8Array(await response.arrayBuffer());
        if (raw.byteLength > DISCORD_ATTACHMENT_MAX_BYTES) {
          throw new Error(
            `attachment exceeds limit ${this.formatBytes(DISCORD_ATTACHMENT_MAX_BYTES)}`,
          );
        }

        fs.writeFileSync(absolutePath, raw);
        savedCount += 1;
        const effectiveType = contentType || response.headers.get('content-type') || 'unknown';
        descriptions.push(
          `[${kind}] name=${originalName}; type=${effectiveType}; size=${this.formatBytes(raw.byteLength)}; saved=/workspace/group/${relativePath}`,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        descriptions.push(
          `[${kind} receive failed] name=${originalName}; error=${errMsg}; url=${sourceUrl.slice(0, 180)}${sourceUrl.length > 180 ? '...' : ''}`,
        );
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }

    logger.info(
      {
        chatJid,
        groupFolder,
        messageId,
        attachmentCount: attachments.length,
        savedCount,
      },
      'Processed Discord attachments',
    );
    return descriptions;
  }

  private ensureRegisteredDiscordGroup(params: {
    chatJid: string;
    chatName: string;
    channelId: string;
    isDm: boolean;
    guildId?: string;
  }): RegisteredGroup | undefined {
    const { chatJid, chatName, channelId, isDm, guildId } = params;
    let group = this.opts.registeredGroups()[chatJid];
    if (!group && this.opts.registerGroup) {
      const folder = isDm
        ? `discord-dm-${channelId}`
        : `discord-guild-${guildId}-${channelId}`;
      this.opts.registerGroup(chatJid, {
        name: chatName,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        // DMs behave like private chat (no trigger required),
        // guild channels require @mention trigger by default.
        requiresTrigger: isDm ? false : true,
      });
      group = this.opts.registeredGroups()[chatJid];
      logger.info(
        { chatJid, folder, isDm },
        isDm
          ? 'Auto-registered Discord DM'
          : 'Auto-registered Discord guild channel',
      );
    }
    return group;
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client || !this.client.isReady()) return;
    const commands = [
      ...SESSION_RESET_SLASH_COMMANDS.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
      })),
      MODELS_SLASH_COMMAND,
    ];

    try {
      await this.client.application?.commands.set(commands);
      logger.info(
        { commandNames: commands.map((c) => c.name) },
        'Registered global Discord slash commands',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to register global Discord slash commands');
    }

    // Guild commands appear immediately and avoid global propagation delay.
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await guild.commands.set(commands);
      } catch (err) {
        logger.debug(
          { guildId: guild.id, err },
          'Failed to register guild slash commands',
        );
      }
    }
  }

  async connect(): Promise<void> {
    enableDiscordGlobalWebSocketPath();
    const { Client, Events, GatewayIntentBits, Partials } = await import(
      'discord.js'
    );

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // Required to receive DM messages reliably in discord.js v14.
      partials: [Partials.Channel],
    });

    this.client.on(Events.InteractionCreate, async (interaction: any) => {
      if (!interaction?.isChatInputCommand?.()) return;
      const commandName = String(interaction.commandName || '').toLowerCase();
      if (
        !SESSION_RESET_COMMAND_NAME_SET.has(commandName)
        && commandName !== 'models'
      ) return;

      const channelId = interaction.channelId;
      if (!channelId) return;
      const isDm = interaction.guild === null;
      const chatJid = `dc:${channelId}`;
      const senderName =
        interaction.member?.displayName ||
        interaction.user?.displayName ||
        interaction.user?.globalName ||
        interaction.user?.username ||
        'User';
      const chatName = interaction.guild
        ? `${interaction.guild.name} #${interaction.channel?.name || channelId}`
        : senderName;

      this.opts.onChatMetadata(chatJid, new Date().toISOString(), chatName);
      const group = this.ensureRegisteredDiscordGroup({
        chatJid,
        chatName,
        channelId,
        isDm,
        guildId: interaction.guild?.id,
      });

      if (!group) {
        const content = 'This channel is not registered for MolClaw.';
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, ephemeral: !isDm });
        } else {
          await interaction.reply({ content, ephemeral: !isDm });
        }
        return;
      }

      if (commandName === 'models') {
        const actionRaw = String(
          interaction.options?.getString?.('action') || 'list',
        ).toLowerCase();
        const action: 'list' | 'show' | 'set' =
          actionRaw === 'set' ? 'set' : actionRaw === 'show' ? 'show' : 'list';
        const provider = interaction.options?.getString?.('provider') || undefined;
        const model = interaction.options?.getString?.('model') || undefined;
        const result = this.opts.handleModelsCommand
          ? this.opts.handleModelsCommand({
            chatJid,
            action,
            provider,
            model,
          })
          : { ok: false, message: 'Model management is not configured.' };

        const content = result.message;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, ephemeral: !isDm });
        } else {
          await interaction.reply({ content, ephemeral: !isDm });
        }
        logger.info(
          { chatJid, commandName, action, provider, model, ok: result.ok },
          'Processed Discord models command',
        );
        return;
      }

      const result = this.opts.resetSession
        ? this.opts.resetSession(chatJid, `discord_slash:${commandName}`)
        : { ok: false, message: 'Session reset is not configured.' };

      const content = result.message;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: !isDm });
      } else {
        await interaction.reply({ content, ephemeral: !isDm });
      }
      logger.info(
        { chatJid, commandName, ok: result.ok },
        'Processed Discord slash session reset command',
      );
    });

    this.client.on(Events.MessageCreate, async (message: any) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      logger.info(
        {
          channelId: message.channelId,
          isDm: message.guild === null,
          authorId: message.author.id,
        },
        'Discord MessageCreate received',
      );

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content || '';
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@MolClaw\\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted or not accessible
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups.
      // Auto-register Discord channels (DM + guild text) on first contact so
      // the bot can respond immediately without manual setup.
      const group = this.ensureRegisteredDiscordGroup({
        chatJid,
        chatName,
        channelId,
        isDm: message.guild === null,
        guildId: message.guild?.id,
      });

      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      if (message.attachments.size > 0) {
        const attachmentDescriptions = await this.materializeDiscordAttachments({
          chatJid,
          groupFolder: group.folder,
          messageId: msgId,
          timestamp,
          attachments: [...message.attachments.values()].map((att) => ({
            name: att.name,
            size: att.size,
            contentType: att.contentType,
            url: att.url,
            proxyURL: att.proxyURL,
          })),
        });
        if (attachmentDescriptions.length > 0) {
          const attachmentBlock = [
            '[Attachments received; local paths are readable from tools]',
            ...attachmentDescriptions,
          ].join('\n');
          if (content) {
            content = `${content}\n${attachmentBlock}`;
          } else {
            content = attachmentBlock;
          }
        }
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    this.client.on(Events.GuildCreate, async (guild: any) => {
      try {
        await guild.commands.set([
          ...SESSION_RESET_SLASH_COMMANDS,
          MODELS_SLASH_COMMAND,
        ]);
        logger.info(
          { guildId: guild.id },
          'Registered Discord slash commands for new guild',
        );
      } catch (err) {
        logger.debug(
          { guildId: guild.id, err },
          'Failed to register slash commands for new guild',
        );
      }
    });

    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        this.registerSlashCommands().catch((err) => {
          logger.warn({ err }, 'Failed to setup Discord slash commands');
        });
        resolve();
      });
      this.client!.login(this.botToken).catch(reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this.client.isReady()) {
      logger.warn({ jid }, 'Discord client not ready, message not sent');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as unknown as {
        send: (content: string) => Promise<unknown>;
      };

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.client || !this.client.isReady()) {
      logger.warn({ jid }, 'Discord client not ready, image not sent');
      return;
    }

    if (!fs.existsSync(imagePath)) {
      logger.warn({ jid, imagePath }, 'Image file does not exist, skipping send');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based for image');
        return;
      }

      const textChannel = channel as unknown as {
        send: (content: {
          content?: string;
          files: string[];
        }) => Promise<unknown>;
      };

      const MAX_CAPTION = 2000;
      const safeCaption = caption && caption.length > MAX_CAPTION
        ? `${caption.slice(0, MAX_CAPTION - 3)}...`
        : caption;

      await textChannel.send({
        content: safeCaption,
        files: [imagePath],
      });
      logger.info({ jid, imagePath, hasCaption: !!safeCaption }, 'Discord image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Discord image');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased() && 'sendTyping' in channel) {
        await (channel as unknown as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}
