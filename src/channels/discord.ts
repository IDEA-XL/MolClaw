import fs from 'fs';

import type { Client, TextChannel } from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
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
}

const SESSION_RESET_SLASH_COMMANDS = [
  {
    name: 'newsession',
    description: 'Start a new BioClaw session for this chat',
  },
  {
    name: 'reset_session',
    description: 'Reset current BioClaw session for this chat',
  },
  {
    name: 'reset',
    description: 'Reset current BioClaw session for this chat',
  },
] as const;

const SESSION_RESET_COMMAND_NAME_SET: Set<string> = new Set(
  SESSION_RESET_SLASH_COMMANDS.map((cmd) => cmd.name),
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
    const commands = SESSION_RESET_SLASH_COMMANDS.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));

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
      if (!SESSION_RESET_COMMAND_NAME_SET.has(commandName)) return;

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
        const content = 'This channel is not registered for BioClaw.';
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, ephemeral: !isDm });
        } else {
          await interaction.reply({ content, ephemeral: !isDm });
        }
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
      // TRIGGER_PATTERN (e.g., ^@Bioclaw\\b), so we prepend the trigger
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

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
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
        await guild.commands.set(SESSION_RESET_SLASH_COMMANDS);
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
