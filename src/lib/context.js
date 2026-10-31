import { MessageFlags } from 'discord.js';

function toPayload(payload) {
  if (typeof payload === 'string') return { content: payload };
  return { ...payload };
}

/**
 * Unified wrapper around a slash interaction or a prefix message.
 * Commands receive one of these, so the same code works for both styles.
 */
export class CommandContext {
  constructor({ client, command, interaction = null, message = null, args = [] }) {
    this.client = client;
    this.command = command;
    this.interaction = interaction;
    this.message = message;
    this.args = args;
    this.lastReply = null;
    this.startedAt = Date.now();
  }

  get isSlash() {
    return this.interaction !== null;
  }

  get isPrefix() {
    return this.message !== null;
  }

  get user() {
    return this.interaction?.user ?? this.message.author;
  }

  get member() {
    return this.interaction?.member ?? this.message?.member ?? null;
  }

  get guild() {
    return this.interaction?.guild ?? this.message?.guild ?? null;
  }

  get guildId() {
    return this.guild?.id ?? null;
  }

  get channel() {
    return this.interaction?.channel ?? this.message.channel;
  }

  get channelId() {
    return this.channel?.id ?? null;
  }

  get commandName() {
    return this.command.name;
  }

  get options() {
    return this.interaction?.options ?? null;
  }

  get deferred() {
    return Boolean(this.interaction?.deferred);
  }

  get replied() {
    return Boolean(this.interaction?.replied);
  }

  // Slash option helpers. They return undefined for prefix commands, so
  // commands should fall back to ctx.args when needed.
  getString(name) {
    return this.interaction?.options.getString(name) ?? undefined;
  }

  getInteger(name) {
    return this.interaction?.options.getInteger(name) ?? undefined;
  }

  getNumber(name) {
    return this.interaction?.options.getNumber(name) ?? undefined;
  }

  getBoolean(name) {
    return this.interaction?.options.getBoolean(name) ?? undefined;
  }

  getUser(name) {
    return this.interaction?.options.getUser(name) ?? undefined;
  }

  getMember(name) {
    return this.interaction?.options.getMember(name) ?? undefined;
  }

  getChannel(name) {
    return this.interaction?.options.getChannel(name) ?? undefined;
  }

  getRole(name) {
    return this.interaction?.options.getRole(name) ?? undefined;
  }

  getMentionable(name) {
    return this.interaction?.options.getMentionable(name) ?? undefined;
  }

  getAttachment(name) {
    return this.interaction?.options.getAttachment(name) ?? undefined;
  }

  getSubcommand() {
    return this.interaction?.options.getSubcommand(false) ?? undefined;
  }

  getSubcommandGroup() {
    return this.interaction?.options.getSubcommandGroup(false) ?? undefined;
  }

  /**
   * Acknowledge the command without a visible reply. Slash only.
   */
  async defer({ ephemeral = false } = {}) {
    if (!this.interaction || this.interaction.deferred || this.interaction.replied) return;
    return this.interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  }

  async reply(payload) {
    const body = toPayload(payload);

    if (this.interaction) {
      this.lastReply =
        this.interaction.deferred || this.interaction.replied
          ? await this.interaction.followUp(body)
          : await this.interaction.reply(body);
      return this.lastReply;
    }

    // Ephemeral flags are interaction-only; strip them for plain messages.
    delete body.flags;
    this.lastReply = await this.message.reply(body);
    return this.lastReply;
  }

  async editReply(payload) {
    const body = toPayload(payload);

    if (this.interaction) {
      this.lastReply = await this.interaction.editReply(body);
      return this.lastReply;
    }

    if (this.lastReply?.editable) {
      this.lastReply = await this.lastReply.edit(body);
      return this.lastReply;
    }

    delete body.flags;
    this.lastReply = await this.channel.send(body);
    return this.lastReply;
  }

  async followUp(payload) {
    const body = toPayload(payload);

    if (this.interaction) {
      this.lastReply = await this.interaction.followUp(body);
      return this.lastReply;
    }

    delete body.flags;
    this.lastReply = await this.channel.send(body);
    return this.lastReply;
  }

  /**
   * Send a new message to the channel (not a reply).
   */
  async send(payload) {
    const body = toPayload(payload);
    delete body.flags;
    return this.channel.send(body);
  }

  /**
   * React to the invoking prefix message. No-op for slash commands.
   */
  async react(emoji) {
    if (!this.message) return null;
    return this.message.react(emoji).catch(() => null);
  }
}
