import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { resolveRole } from '../../lib/resolve.js';
import { roleProblem } from '../../services/exile.js';
import {
  EXILE_LEVELS,
  clearRoleMapping,
  isRoleSetUp,
  levelLabel,
  listRoleMappings,
  normalizeLevel,
  setRoleMapping,
} from '../../services/exile-store.js';
import { done, fail, info } from './_shared.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تربط مستويات العزل.');

  return false;
}

const LEVEL_CHOICES = EXILE_LEVELS.map((level) => ({ name: levelLabel(level), value: level }));

async function handleSet(ctx) {
  const rawLevel = ctx.isSlash ? ctx.getString('level') : ctx.args[1];
  const level = normalizeLevel(rawLevel);

  if (!level) {
    await fail(
      ctx,
      'مستوى غير صحيح',
      `استخدم \`main\` أو رقم من 1 إلى 10، مثل \`${ctx.isSlash ? '/exile-role set level:3 role:@Exile 3' : ':-exile-role set 3 @Exile 3'}\`.`,
    );
    return;
  }

  const role = ctx.isSlash
    ? ctx.getRole('role')
    : await resolveRole(ctx.guild, ctx.args[2]).catch(() => null);

  if (!role) {
    await fail(
      ctx,
      'رتبة غير معروفة',
      'منشن رتبة العزل أو الصق آيديها، مثل `:-exile-role set 3 @Exile3`.',
    );
    return;
  }

  const problem = roleProblem(ctx.guild, role);

  if (problem) {
    await fail(ctx, 'ما أقدر أستخدم هذي الرتبة', problem);
    return;
  }

  const { previous, previousLevel } = setRoleMapping(ctx.guildId, level, role.id);
  const setUp = isRoleSetUp(ctx.guildId, role.id);

  const lines = [`**${levelLabel(level)}** → ${role}`];

  if (previous && previous !== role.id) {
    lines.push(`هذا المستوى كان يستخدم <@&${previous}>.`);
  }

  if (previousLevel && previousLevel !== level) {
    lines.push(`${role} كان مربوط بـ **${levelLabel(previousLevel)}** ونقلته.`);
  }

  if (!setUp) {
    lines.push(
      '',
      `⚠️ هذي الرتبة **ما انضبطت** بعد. شغّل \`/exile-setup role:${role.name}\` قبل تستخدمها — بدونها ما تنخفي أي قناة.`,
    );

    await info(ctx, 'تم حفظ مستوى العزل', lines.join('\n'));
    return;
  }

  await done(ctx, 'تم حفظ مستوى العزل', lines.join('\n'));
}

async function handleClear(ctx) {
  const rawLevel = ctx.isSlash ? ctx.getString('level') : ctx.args[1];
  const level = normalizeLevel(rawLevel);

  if (!level) {
    await fail(ctx, 'مستوى غير صحيح', 'استخدم `main` أو رقم من 1 إلى 10.');
    return;
  }

  const removed = clearRoleMapping(ctx.guildId, level);

  if (removed > 0) {
    await done(
      ctx,
      'تم مسح مستوى العزل',
      `**${levelLabel(level)}** ما عاد له رتبة. الرتبة نفسها وقواعد قنواتها ما تتغيّر.`,
    );
    return;
  }

  await info(ctx, 'ما فيه شي لمسحه', `**${levelLabel(level)}** ما كان مربوط برتبة.`);
}

function listPayload(ctx) {
  const mappings = new Map(
    listRoleMappings(ctx.guildId).map((entry) => [entry.level, entry.roleId]),
  );

  const lines = EXILE_LEVELS.map((level) => {
    const roleId = mappings.get(level);

    if (!roleId) return `**${levelLabel(level)}** — *غير مربوط*`;

    const role = ctx.guild.roles.cache.get(roleId);
    const name = role ? role.toString() : `<@&${roleId}> (محذوفة)`;
    const ready = isRoleSetUp(ctx.guildId, roleId);

    return `**${levelLabel(level)}** — ${name}${ready ? '' : ' ⚠️ ما انضبطت'}`;
  });

  const configured = mappings.size;

  return embed({
    title: `مستويات العزل (${configured}/${EXILE_LEVELS.length})`,
    description: lines.join('\n'),
    color: configured === EXILE_LEVELS.length ? COLORS.primary : COLORS.warning,
    footer:
      'اربط بـ /exile-role set · اخفِ القنوات بـ /exile-setup · استخدم /exile user:@member level:<n>',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-role')
    .setDescription('اربط كل مستوى عزل بإحدى رتب العزل')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('اختر الرتبة المستخدمة لمستوى')
        .addStringOption((option) =>
          option
            .setName('level')
            .setDescription('الرئيسي أو 1–10')
            .setRequired(true)
            .addChoices(...LEVEL_CHOICES),
        )
        .addRoleOption((option) =>
          option.setName('role').setDescription('رتبة العزل').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('clear')
        .setDescription('انسَ الرتبة المربوطة بمستوى')
        .addStringOption((option) =>
          option
            .setName('level')
            .setDescription('الرئيسي أو 1–10')
            .setRequired(true)
            .addChoices(...LEVEL_CHOICES),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('اعرض كل مستوى ورتبته')),

  name: 'exile-role',
  description: 'اربط كل مستوى عزل بإحدى رتب العزل',
  category: 'Moderation',
  usage: 'exile-role set <main|1-10> <@role> | clear <main|1-10> | list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['set', 'clear', 'delete', 'list'].includes(ctx.args[0])
        ? ctx.args[0]
        : 'list';

    if (sub === 'set') return handleSet(ctx);
    if (sub === 'clear' || sub === 'delete') return handleClear(ctx);

    await ctx.reply(ephemeral({ embeds: [listPayload(ctx)] }));
  },
};
