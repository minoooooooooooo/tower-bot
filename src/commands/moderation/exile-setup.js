import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { okReply, warnReply } from '../../lib/replies.js';
import { resolveChannel, resolveRole } from '../../lib/resolve.js';
import { reconcileRole, roleProblem } from '../../services/exile.js';
import { markRoleSetUp, replaceExceptions } from '../../services/exile-store.js';
import { ephemeral, fail, respond } from './_shared.js';

const MAX_EXCEPT_REPORTED = 10;

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تضبط رتب العزل.');

  return false;
}

function tokenList(raw) {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

async function resolveChannels(guild, tokens) {
  const found = new Map();
  const unknown = [];

  for (const token of tokens) {
    const channel = await resolveChannel(guild, token).catch(() => null);

    if (channel) found.set(channel.id, channel);
    else unknown.push(token);
  }

  return { channels: [...found.values()], unknown };
}

function failureLines(failed) {
  return failed
    .slice(0, MAX_EXCEPT_REPORTED)
    .map((entry) => `• #${entry.name} — ${entry.message}`)
    .join('\n');
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-setup')
    .setDescription('اخفِ كل القنوات عن رتبة عزل إلا اللي تحددها')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addRoleOption((option) =>
      option
        .setName('role')
        .setDescription('رتبة العزل اللي تبي تضبطها')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('except')
        .setDescription('قنوات تبقى ظاهرة، مثل #exile-chat #rules (اتركها فاضية تخفي الكل)')
        .setRequired(false)
        .setMaxLength(1000),
    ),

  name: 'exile-setup',
  description: 'اخفِ كل القنوات عن رتبة عزل إلا اللي تحددها',
  category: 'Moderation',
  usage: 'exile-setup <@role> [#channel ...]',
  cooldown: 5,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    const role = ctx.isSlash
      ? ctx.getRole('role')
      : await resolveRole(ctx.guild, ctx.args[0]).catch(() => null);

    if (!role) {
      await fail(
        ctx,
        'رتبة غير معروفة',
        `منشن الرتبة أو الصق آيديها، مثل \`${ctx.isSlash ? '/exile-setup role:@Exile 1' : ':-exile-setup @Exile1 #exile-1'}\`.`,
      );
      return;
    }

    const problem = roleProblem(ctx.guild, role);

    if (problem) {
      await fail(ctx, 'ما أقدر أستخدم هذي الرتبة', problem);
      return;
    }

    const rawTokens = ctx.isSlash
      ? tokenList(ctx.getString('except'))
      : ctx.args.slice(1);

    const { channels, unknown } = await resolveChannels(ctx.guild, rawTokens);

    if (unknown.length > 0) {
      await fail(
        ctx,
        'قناة غير معروفة',
        `ما لقيت: ${unknown.map((token) => `\`${token}\``).join('، ')}. منشن القنوات كـ \`#channel\` أو الصق آيديها.`,
      );
      return;
    }

    // Slash needs an early acknowledgement; applying a role to every channel
    // can take longer than Discord's three-second window.
    if (ctx.isSlash) {
      await ctx.defer({ ephemeral: true });
    } else {
      await respond(
        ctx,
        ephemeral(
          warnReply(
            'أطبّق قواعد العزل…',
            `أخفي كل القنوات عن ${role}، إلا ${channels.length === 0 ? 'ما فيه' : channels.map((channel) => channel.toString()).join('، ')}. ممكن ياخذ لحظة.`,
          ),
        ),
      );
    }

    replaceExceptions(ctx.guildId, role.id, channels.map((channel) => channel.id));
    markRoleSetUp(ctx.guildId, role.id);

    const result = await reconcileRole(ctx.guild, role, channels.map((channel) => channel.id), {
      reason: `إعداد العزل: ${role.name}`,
    });

    const lines = [
      `**${role}** — القنوات المسموحة: **${channels.length === 0 ? 'ما فيه' : channels.length}**.`,
      `طبّقت على **${result.updated}** قناة · **${result.skipped}** كانت مضبوطة.`,
    ];

    if (result.failed.length > 0) {
      lines.push(
        '',
        `⚠️ **${result.failed.length}** قناة ما انضبطت:`,
        failureLines(result.failed),
      );

      if (result.failed.length > MAX_EXCEPT_REPORTED) {
        lines.push(`…و ${result.failed.length - MAX_EXCEPT_REPORTED} غيرها.`);
      }

      lines.push('شغّل الإعداد مرة ثانية عشان تكمّل الباقي.');
    }

    if (channels.length > 0) {
      lines.push('', `القنوات المسموحة: ${channels.map((channel) => channel.toString()).join('، ')}`);
    }

    lines.push(
      '',
      'التالي: اربطها بـ `/exile-role set level:<main|1-10> role:@role`. القنوات الجديدة تنخفي تلقائيًا.',
    );

    await ctx.editReply(
      result.failed.length > 0
        ? warnReply('تم تطبيق الإعداد جزئيًا', lines.join('\n'))
        : okReply('تم حفظ إعداد العزل', lines.join('\n')),
    );
  },
};
