import { SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { embed } from '../../lib/embeds.js';
import { attachPager, chunkPages, pagerMessage, withPager } from '../../lib/pager.js';
import { errorReply } from '../../lib/replies.js';
import { getAlias, listAliases } from '../../services/alias-store.js';

/** Arabic names for the categories the loader assigns. */
const CATEGORY_LABELS = {
  General: 'عامة',
  Moderation: 'إشراف',
  Profile: 'الملف',
  Community: 'المجتمع',
  Activity: 'النشاط',
};

function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category;
}

/** One field per category inside the page, so the headings stay readable. */
function pageFields(entries) {
  const fields = [];
  const MAX_FIELD_LENGTH = 1000;

  for (const entry of entries) {
    const label = categoryLabel(entry.category);
    const last = fields.at(-1);

    if (last?.name === label && last.value.length + entry.line.length + 1 <= MAX_FIELD_LENGTH) {
      last.value += `\n${entry.line}`;
    } else {
      // A category can still be longer than one embed field. Discord allows
      // duplicate field names, so the continuation stays under the same label.
      fields.push({ name: label, value: entry.line, inline: false });
    }
  }

  return fields;
}

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('اعرض كل الأوامر، أو تفاصيل أمر واحد')
    .addStringOption((option) =>
      option
        .setName('command')
        .setDescription('اسم الأمر اللي تبي تفاصيله')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  name: 'help',
  aliases: ['commands', 'h'],
  description: 'اعرض كل الأوامر، أو تفاصيل أمر واحد',
  category: 'General',
  usage: 'help [command]',
  cooldown: 3,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();

    const matches = [...interaction.client.commands.values()]
      .filter((command) => command.name.includes(focused))
      .slice(0, 25)
      .map((command) => ({ name: `/${command.name}`, value: command.name }));

    await interaction.respond(matches);
  },

  async execute(ctx, client) {
    const query = (ctx.isSlash ? ctx.getString('command') : ctx.args[0])?.toLowerCase();
    const all = [...client.commands.values()];

    if (query) {
      const builtIn = client.commands.get(client.aliases.get(query) ?? query);
      const custom = builtIn || !ctx.guildId ? null : getAlias(ctx.guildId, query);
      const command = builtIn ?? (custom ? client.commands.get(custom.command) : null);

      if (!command) {
        await ctx.fail(
          errorReply(
            'الأمر غير موجود',
            `ما فيه أمر اسمه \`${query}\`. شغّل \`${config.prefix}help\` عشان تشوف الكل.`,
          ),
        );
        return;
      }

      const usage = command.usage ?? command.name;
      // Only list built-in aliases that actually resolve here; a real command
      // name wins over another command's alias (for example /top's old "rank").
      const names = (command.aliases ?? []).filter(
        (alias) => client.aliases.get(alias.toLowerCase()) === command.name,
      );

      // Custom aliases live in SQLite, not in the command module, so they are
      // merged here to make `help <command>` the one place that lists them.
      for (const alias of ctx.guildId ? listAliases(ctx.guildId) : []) {
        if (alias.command !== command.name) continue;
        if (names.some((name) => name.toLowerCase() === alias.label.toLowerCase())) continue;
        names.push(alias.label);
      }

      const aliases = names.length
        ? names.map((alias) => `\`${config.prefix}${alias}\``).join('، ')
        : 'ما فيه';

      await ctx.reply({
        embeds: [
          embed({
            title: `/${command.name}`,
            description: command.description ?? 'ما فيه وصف.',
            fields: [
              {
                name: 'الاستخدام',
                value: `\`/${usage}\` أو \`${config.prefix}${usage}\``,
              },
              { name: 'الأسماء البديلة', value: aliases, inline: true },
              { name: 'الانتظار', value: `${command.cooldown ?? 3} ثانية`, inline: true },
              { name: 'الفئة', value: categoryLabel(command.category ?? 'General'), inline: true },
            ],
          }),
        ],
      });
      return;
    }

    const groups = new Map();

    for (const command of all) {
      const category = command.category ?? 'General';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(command);
    }

    const entries = [...groups.entries()]
      .sort(([a], [b]) => categoryLabel(a).localeCompare(categoryLabel(b), 'ar'))
      .flatMap(([category, list]) =>
        [...list]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((command) => ({
            category,
            line: `\`/${command.name}\` — ${command.description ?? 'ما فيه وصف.'}`,
          })),
      );

    const pages = chunkPages(entries);
    const total = pages.length;

    const render = (page) => ({
      embeds: [
        embed({
          title: 'الأوامر',
          description: [
            `استخدم \`/command\` أو \`${config.prefix}command\`.`,
            `أضف اسم الأمر للتفاصيل: \`${config.prefix}help ping\`.`,
          ].join('\n'),
          fields: pageFields(pages[page - 1] ?? []),
          footer:
            total > 1
              ? `صفحة ${page} / ${total} · ${all.length} أمر متاح`
              : `${all.length} أمر متاح`,
        }),
      ],
    });

    const sent = await ctx.reply(
      withPager({ id: 'help', page: 1, pages: total, payload: render(1) }),
    );

    await attachPager({
      ctx,
      message: await pagerMessage(ctx, sent),
      id: 'help',
      pages: total,
      render,
    });
  },
};
