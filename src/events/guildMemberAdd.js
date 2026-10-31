import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { getGuildSettings } from '../services/birthday-store.js';
import { buildWelcomePayload, chooseStyle } from '../services/welcome-styles.js';
import { getWelcomeSettings, getWelcomeTexts, setLastStyle } from '../services/welcome-store.js';

const logger = createLogger('welcome');

const warned = new Map();
const WARN_INTERVAL_MS = 60 * 60 * 1000;

/** A broken channel would otherwise log once per join. */
function warnThrottled(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < WARN_INTERVAL_MS) return;
  warned.set(key, now);
  logger.warn(message);
}

async function resolveChannel(guild, channelId) {
  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

export default {
  name: 'guildMemberAdd',
  async execute(member) {
    if (member.user?.bot) return;

    const guild = member.guild;
    const settings = getWelcomeSettings(guild.id);
    if (!settings.channelId) return;

    const channel = await resolveChannel(guild, settings.channelId);

    if (!channel || typeof channel.send !== 'function') {
      warnThrottled(
        `channel:${guild.id}`,
        `[${guild.name}] Welcome channel ${settings.channelId} is missing or not sendable`,
      );
      return;
    }

    const me = guild.members.me;
    const permissions = me ? channel.permissionsFor?.(me) : null;

    if (
      permissions &&
      !(
        permissions.has(PermissionFlagsBits.SendMessages) &&
        permissions.has(PermissionFlagsBits.EmbedLinks)
      )
    ) {
      warnThrottled(
        `perm:${guild.id}:${channel.id}`,
        `[${guild.name}] Cannot post a welcome card in #${channel.name}: needs Send Messages and Embed Links`,
      );
      return;
    }

    const styleKey = chooseStyle(settings);
    const texts = getWelcomeTexts(guild.id);
    const timeZone = getGuildSettings(guild.id).timezone ?? config.timezone;

    const payload = buildWelcomePayload({
      guild,
      member,
      settings,
      styleKey,
      overrides: texts[styleKey] ?? {},
      timeZone,
    });

    try {
      await channel.send(payload);
      setLastStyle(guild.id, styleKey);
    } catch (error) {
      warnThrottled(
        `send:${guild.id}`,
        `[${guild.name}] Welcome card failed: ${error.message}`,
      );
    }
  },
};
