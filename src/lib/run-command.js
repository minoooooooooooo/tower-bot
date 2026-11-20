import { MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { permissionName } from './permissions.js';
import { errorReply } from './replies.js';
import { logger } from './logger.js';
import { hasGrantForMember } from '../services/permission-store.js';

const cooldowns = new Map();

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
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
    await ctx.reply(ephemeral(errorReply(title, description)));
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
    await replyError(ctx, 'السيرفر فقط', 'هذا الأمر يشتغل داخل السيرفر فقط.');
    return;
  }

  if (command.ownerOnly && !config.ownerIds.includes(user.id)) {
    await replyError(ctx, 'للمالك فقط', 'ما عندك صلاحية تشغيل هذا الأمر.');
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
        'صلاحيات ناقصة',
        `تحتاج: ${missing.map(permissionName).join('، ')}`,
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
        'تمهّل',
        `جرّب بعد ${formatDuration(expiresAt - Date.now())}.`,
      );
      return;
    }

    cooldowns.set(cooldownKey, Date.now() + cooldownMs);
    pruneCooldowns();
  }

  const releaseCooldown = () => {
    if (cooldownKey) cooldowns.delete(cooldownKey);
  };

  let typingTimer = null;

  try {
    // Prefix commands have no "thinking…" state of their own, so show the
    // typing indicator while the command fetches, renders or writes. Discord
    // drops the indicator after ten seconds, so re-send it for slow work such
    // as an AI summary.
    if (ctx.isPrefix) {
      await ctx.typing();
      typingTimer = setInterval(() => ctx.typing(), 8000);
      typingTimer.unref?.();
    }

    await command.execute(ctx, ctx.client);

    if (ctx.failed) releaseCooldown();
  } catch (error) {
    releaseCooldown();

    logger.error(
      `Command "${command.name}" failed for ${user.tag ?? user.username} (${user.id})`,
      error,
    );

    const payload = ephemeral(errorReply('فشل الأمر', 'صار خطأ أثناء تنفيذ الأمر.'));

    try {
      if (ctx.interaction) {
        if (ctx.interaction.deferred || ctx.interaction.replied) {
          await ctx.interaction.followUp(payload);
        } else {
          await ctx.interaction.reply(payload);
        }
      } else {
        await ctx.message.reply({ content: payload.content });
      }
    } catch {
      // Ignore secondary failures.
    }
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
}
