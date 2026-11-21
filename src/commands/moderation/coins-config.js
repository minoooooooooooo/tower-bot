import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { errorReply, infoReply, okReply } from '../../lib/replies.js';
import { setTransferEnabled, transferEnabled } from '../../services/profile-store.js';

const OFF_WORDS = ['off', 'disable', 'disabled', 'false', 'no', 'stop'];
const ON_WORDS = ['on', 'enable', 'enabled', 'true', 'yes', 'start'];

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(
      errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تغيّر تحويل الكوينز.'),
    ),
  );

  return false;
}

function statusPayload(guildId) {
  const enabled = transferEnabled(guildId);
  const body = enabled
    ? `الأعضاء يقدرون يحوّلون كوينز بـ \`${config.prefix}coins @member <amount>\`.`
    : 'الأعضاء ما يقدرون يحوّلون لبعض. تقدر تتأكد من الأرصدة عادي.';

  return ephemeral(
    infoReply(enabled ? 'تحويل الكوينز شغّال' : 'تحويل الكوينز مقفّل', [
      body,
      `تغيّره بـ \`${config.prefix}coins-config on|off\`.`,
    ].join('\n')),
  );
}

/** Applies one state token. Returns the payload to send back (or null to show status). */
function applyState(ctx, token) {
  const raw = String(token ?? '').trim().toLowerCase();

  if (!raw || raw === 'status' || raw === 'show') return null;

  if (ON_WORDS.includes(raw)) {
    setTransferEnabled(ctx.guildId, true);

    return ephemeral(
      okReply(
        'تحويل الكوينز شغّال',
        `الأعضاء الحين يقدرون يحوّلون بـ \`${config.prefix}coins @member <amount>\`.`,
      ),
    );
  }

  if (OFF_WORDS.includes(raw)) {
    setTransferEnabled(ctx.guildId, false);

    return ephemeral(
      okReply(
        'تحويل الكوينز مقفّل',
        `الحين تتأكد من الأرصدة بس. ترجّعه بـ \`${config.prefix}coins-config on\`.`,
      ),
    );
  }

  return undefined;
}

export default {
  data: new SlashCommandBuilder()
    .setName('coins-config')
    .setDescription('شغّل أو اقفل تحويل الكوينز بين الأعضاء')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('on أو off أو status (الافتراضي status)')
        .addChoices(
          { name: 'الحالة', value: 'status' },
          { name: 'تشغيل', value: 'on' },
          { name: 'إيقاف', value: 'off' },
        )
        .setRequired(false),
    ),

  name: 'coins-config',
  aliases: ['coin-config', 'coinsconfig'],
  description: 'شغّل أو اقفل تحويل الكوينز بين الأعضاء',
  category: 'Moderation',
  usage: 'coins-config [on|off|status]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    const token = ctx.isSlash ? ctx.getString('state') ?? 'status' : ctx.args[0] ?? 'status';
    const payload = applyState(ctx, token);

    if (payload === undefined) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'قيمة غير معروفة',
            `استخدم \`${config.prefix}coins-config on\`، \`${config.prefix}coins-config off\`، أو \`${config.prefix}coins-config status\`.`,
          ),
        ),
      );
      return;
    }

    await ctx.reply(payload ?? statusPayload(ctx.guildId));
  },
};
