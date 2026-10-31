import { SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed } from '../../lib/embeds.js';

const MAX_FIELD_LENGTH = 1000;

function chunkLines(lines, limit = MAX_FIELD_LENGTH) {
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (current.length + line.length + 1 > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List every command, or get details about one')
    .addStringOption((option) =>
      option
        .setName('command')
        .setDescription('Show details for a specific command')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  name: 'help',
  aliases: ['commands', 'h'],
  description: 'List every command, or get details about one',
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
      const command = client.commands.get(client.aliases.get(query) ?? query);

      if (!command) {
        await ctx.reply({
          embeds: [
            embed({
              title: 'Command not found',
              description: `No command called \`${query}\`. Run \`${config.prefix}help\` to see them all.`,
              color: COLORS.danger,
            }),
          ],
        });
        return;
      }

      const usage = command.usage ?? command.name;
      const aliases = command.aliases?.length
        ? command.aliases.map((alias) => `\`${config.prefix}${alias}\``).join(', ')
        : 'None';

      await ctx.reply({
        embeds: [
          embed({
            title: `/${command.name}`,
            description: command.description ?? 'No description.',
            fields: [
              {
                name: 'Usage',
                value: `\`/${usage}\` or \`${config.prefix}${usage}\``,
              },
              { name: 'Aliases', value: aliases, inline: true },
              { name: 'Cooldown', value: `${command.cooldown ?? 3}s`, inline: true },
              { name: 'Category', value: command.category ?? 'General', inline: true },
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

    const fields = [];

    for (const [category, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const lines = list
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((command) => `\`/${command.name}\` - ${command.description ?? 'No description.'}`);

      const chunks = chunkLines(lines);

      chunks.forEach((chunk, index) => {
        fields.push({
          name: index === 0 ? category : `${category} (cont.)`,
          value: chunk,
        });
      });
    }

    await ctx.reply({
      embeds: [
        embed({
          title: 'Commands',
          description: [
            `Use \`/command\` or \`${config.prefix}command\`.`,
            `Add a name for details: \`${config.prefix}help ping\`.`,
          ].join('\n'),
          fields,
          footer: `${all.length} command(s) available`,
        }),
      ],
    });
  },
};
