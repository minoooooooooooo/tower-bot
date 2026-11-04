import { MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { errorEmbed } from './embeds.js';
import { logger } from './logger.js';
import { hasGrantForMember } from '../services/permission-store.js';

const cooldowns = new Map();

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

function humanizePermission(flag) {
  if (typeof flag === 'string') {
    return flag.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  const name = Object.keys(PermissionsBitField.Flags).find(
    (key) => PermissionsBitField.Flags[key] === flag,
  );

  return name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : String(flag);
}

function formatDuration(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function pruneCooldowns() {
  if (cooldowns.size < 500) return;

  const now = Date.now();
  for (const [key, expires] of cooldowns) {
    if (expires <= now) cooldowns.delete(key);
  }
}

async function replyError(ctx, title, description) {
  try {
    await ctx.reply(ephemeral({ embeds: [errorEmbed(title, description)] }));
  } catch {
    // The interaction may have expired; nothing useful to do.
  }
}

/**
 * Shared execution pipeline for slash and prefix commands:
 * guild check -> owner check -> permissions -> cooldown -> execute.
 */
export async function runCommand(command, ctx) {
  const { user, guild, member } = ctx;

  if (command.guildOnly && !guild) {
    await replyError(ctx, 'Server only', 'This command can only be used inside a server.');
    return;
  }

  if (command.ownerOnly && !config.ownerIds.includes(user.id)) {
    await replyError(ctx, 'Owner only', 'You are not allowed to run this command.');
    return;
  }

  const required = command.permissions ?? [];

  if (required.length > 0 && guild) {
    const missing = member?.permissions
      ? required.filter((permission) => !member.permissions.has(permission))
      : required;

    // A bot-side grant (/perm grant) lets a role run the command without the
    // Discord permission. Hierarchy checks inside the command still apply.
    const granted =
      missing.length > 0 && member
        ? hasGrantForMember(guild.id, command.name, member)
        : false;

    if (missing.length > 0 && !granted) {
      await replyError(
        ctx,
        'Missing permissions',
        `You need: ${missing.map(humanizePermission).join(', ')}`,
      );
      return;
    }
  }

  // Reserve the slot before executing so two runs cannot start at once, but
  // give it back if the command reports that it did nothing useful. A typo in
  // an argument should not lock the user out for the whole cooldown.
  let cooldownKey = null;
  const cooldownMs = (command.cooldown ?? 3) * 1000;

  if (cooldownMs > 0) {
    cooldownKey = `${command.name}:${user.id}`;
    const expiresAt = cooldowns.get(cooldownKey) ?? 0;

    if (Date.now() < expiresAt) {
      await replyError(
        ctx,
        'Slow down',
        `Try again in ${formatDuration(expiresAt - Date.now())}.`,
      );
      return;
    }

    cooldowns.set(cooldownKey, Date.now() + cooldownMs);
    pruneCooldowns();
  }

  const releaseCooldown = () => {
    if (cooldownKey) cooldowns.delete(cooldownKey);
  };

  try {
    await command.execute(ctx, ctx.client);

    if (ctx.failed) releaseCooldown();
  } catch (error) {
    releaseCooldown();

    logger.error(
      `Command "${command.name}" failed for ${user.tag ?? user.username} (${user.id})`,
      error,
    );

    const payload = ephemeral({
      embeds: [errorEmbed('Command failed', 'Something went wrong while running this command.')],
    });

    try {
      if (ctx.interaction) {
        if (ctx.interaction.deferred || ctx.interaction.replied) {
          await ctx.interaction.followUp(payload);
        } else {
          await ctx.interaction.reply(payload);
        }
      } else {
        await ctx.message.reply({ embeds: payload.embeds });
      }
    } catch {
      // Ignore secondary failures.
    }
  }
}
