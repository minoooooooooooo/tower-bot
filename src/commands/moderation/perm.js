import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { permissionName } from '../../lib/permissions.js';
import { errorReply, okReply, warnReply } from '../../lib/replies.js';
import { resolveRole } from '../../lib/resolve.js';
import { addGrant, listGrants, removeGrant } from '../../services/permission-store.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function findCommand(client, name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;

  return client.commands.get(client.aliases.get(key) ?? key) ?? null;
}

function roleName(id, guild) {
  return guild.roles.cache.get(id)?.toString() ?? `<@&${id}>`;
}

/** Short plain-text refusal; releases the cooldown like every other bad input. */
function fail(ctx, title, body) {
  return ctx.fail(ephemeral(errorReply(title, body)));
}

async function doGrant(ctx, client, { grant }) {
  const role = ctx.isSlash ? ctx.getRole('role') : await resolveRole(ctx.guild, ctx.args[1]);
  const command = await findCommand(
    client,
    ctx.isSlash ? ctx.getString('command') : ctx.args[2],
  );

  if (!role) {
    await fail(ctx, 'رتبة غير معروفة', 'منشن الرتبة أو الصق آيديها.');
    return;
  }

  if (role.id === ctx.guild.id) {
    await fail(
      ctx,
      'مو @everyone',
      'منح أمر لـ @everyone بيعطيه لكل الأعضاء. اختر رتبة حقيقية.',
    );
    return;
  }

  if (!command) {
    await fail(
      ctx,
      'أمر غير معروف',
      `ما فيه أمر بهذا الاسم. جرّب \`${ctx.isSlash ? '/perm list' : ':-perm list'}\` عشان تشوف المنح الحالية.`,
    );
    return;
  }

  if (command.name === 'perm' || command.grantable === false) {
    await fail(
      ctx,
      'ما ينمنح',
      '**perm** نفسه ما ينمنح — بيخلي الرتبة توزّع صلاحيات أكثر.',
    );
    return;
  }

  if (!command.permissions?.length) {
    await fail(
      ctx,
      'ما فيه شي ينمنح',
      `**${command.name}** ما يحتاج صلاحية، فالكل يقدر يشغّله أصلًا.`,
    );
    return;
  }

  const permissions = command.permissions.map(permissionName).join('، ');

  if (grant) {
    const added = addGrant(ctx.guildId, command.name, role.id, ctx.user.id);

    const body = added
      ? `${role} الحين تقدر تشغّل **${command.name}** بدون ${permissions}.\n_فحص الرتب يبقى: ما تقدر تتحكم بأحد فوقها._`
      : `${role} كانت تقدر تشغّل **${command.name}** من قبل.`;

    await ctx.reply(
      ephemeral(added ? okReply('تم منح الصلاحية', body) : warnReply('ممنوحة أصلًا', body)),
    );
    return;
  }

  const removed = removeGrant(ctx.guildId, command.name, role.id);

  await ctx.reply(
    ephemeral(
      removed
        ? okReply('تم سحب الصلاحية', `${role} ما عادت تتجاوز فحص **${command.name}**.`)
        : warnReply('ما فيه شي لسحبه', `${role} ما كان عندها منح لـ **${command.name}**.`),
    ),
  );
}

function doList(ctx) {
  const filter = String(
    ctx.isSlash ? ctx.getString('command') ?? '' : ctx.args[1] ?? '',
  )
    .trim()
    .toLowerCase();
  const grants = listGrants(ctx.guildId, filter || null);

  if (grants.length === 0) {
    ctx.reply(
      ephemeral(
        warnReply(
          'ما فيه صلاحيات ممنوحة',
          'ما فيه رتبة عندها منح بعد.\n' +
            `ضيف منح بـ \`${ctx.isSlash ? '/perm grant role:@Mod command:kick' : ':-perm grant @Mod kick'}\`.`,
        ),
      ),
    );
    return;
  }

  const byCommand = new Map();

  for (const grant of grants) {
    if (!byCommand.has(grant.command)) byCommand.set(grant.command, []);
    byCommand.get(grant.command).push(roleName(grant.roleId, ctx.guild));
  }

  const lines = [...byCommand.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([command, roles]) => `**${command}** — ${roles.join('، ')}`);

  ctx.reply({
    embeds: [
      embed({
        title: 'صلاحيات الأوامر',
        description:
          `${lines.join('\n')}\n\n` +
          '_هذي منح من البوت: صلاحيات الرتبة الحقيقية في ديسكورد ما تتغيّر._',
        color: COLORS.primary,
      }),
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('perm')
    .setDescription('امنح أمرًا لرتبة أو اسحبه بدون تغيير صلاحيات ديسكورد')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('grant')
        .setDescription('خلّ رتبة تشغّل أمرًا بدون صلاحيته في ديسكورد')
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تنمنح').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('command').setDescription('اسم الأمر، مثل kick').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('revoke')
        .setDescription('اسحب منح رتبة لأمر')
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تتغيّر').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('command').setDescription('اسم الأمر، مثل kick').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('اعرض كل منح الأوامر في هذا السيرفر')
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('اعرض هذا الأمر فقط')
            .setRequired(false),
        ),
    ),

  name: 'perm',
  aliases: ['perms', 'commandperm'],
  description: 'امنح أمرًا لرتبة أو اسحبه بدون تغيير صلاحيات ديسكورد',
  category: 'Moderation',
  usage: 'perm grant|revoke <@role> <command> | perm list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx, client) {
    const action = ctx.isSlash
      ? ctx.getSubcommand()
      : String(ctx.args[0] ?? '').toLowerCase();

    if (action === 'grant' || action === 'revoke') {
      await doGrant(ctx, client, { grant: action === 'grant' });
      return;
    }

    if (action === 'list' || !action) {
      doList(ctx);
      return;
    }

    await fail(
      ctx,
      'خيار غير معروف',
      `استخدم \`${ctx.isSlash ? '/perm grant' : ':-perm grant'} <role> <command>\`، \`revoke\`، أو \`list\`.`,
    );
  },
};
