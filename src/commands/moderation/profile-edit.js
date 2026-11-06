import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed } from '../../lib/embeds.js';
import { resolveUser } from '../../lib/resolve.js';
import { displayNameOf } from '../../lib/targets.js';
import {
  MAX_TITLE_LENGTH,
  addProfilePoints,
  displayedPunishments,
  ensureExileBackfill,
  getProfile,
  levelFor,
  profileStats,
  progressFor,
  setProfileTitle,
  xpFor,
} from '../../services/profile-store.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

const CLEAR_TITLE = new Set(['reset', 'clear', 'none', '-']);

const FIELDS = {
  nightmare: 'nightmare',
  night: 'nightmare',
  vex: 'vex',
  punishment: 'punishMini',
  punishments: 'punishMini',
  punish: 'punishMini',
  behavior: 'goodBehavior',
  behaviour: 'goodBehavior',
  behavior_points: 'goodBehavior',
  behaviour_points: 'goodBehavior',
  good: 'goodBehavior',
};

function summaryLines(before, after, changes) {
  const lines = [];

  if (changes.title !== undefined) {
    lines.push(
      `**Title:** ${before.title ?? 'No Title'} → ${after.title ?? 'No Title'}`,
    );
  }

  if (changes.nightmare) {
    lines.push(`**Nightmare points:** ${before.nightmare} → ${after.nightmare}`);
  }

  if (changes.vex) {
    lines.push(`**Vex points:** ${before.vex} → ${after.vex}`);
  }

  if (changes.punishMini) {
    lines.push(
      `**Punishment mini points:** ${before.punishMini} → ${after.punishMini} ` +
        `(${displayedPunishments(after)} shown)`,
    );
  }

  if (changes.goodBehavior) {
    lines.push(
      `**Good behavior:** ${before.goodBehavior} → ${after.goodBehavior}`,
    );
  }

  return lines;
}

function currentBlock(profile) {
  const xp = xpFor(profile);

  return [
    `**Title:** ${profile.title ?? 'No Title'}`,
    `**Nightmare:** ${profile.nightmare} · **Vex:** ${profile.vex} · **XP:** ${xp} (level ${levelFor(xp)})`,
    `**Punishments:** ${displayedPunishments(profile)} (${profile.punishMini} mini points)`,
    `**Good behavior:** ${profile.goodBehavior}`,
  ].join('\n');
}

function parseAmount(value) {
  const number = Number.parseInt(String(value ?? '').replace(/^\+/, ''), 10);
  return Number.isFinite(number) ? number : null;
}

/** Slash: options are already typed and validated by Discord. */
function slashChanges(ctx) {
  const title = ctx.getString('title');
  const changes = {
    nightmare: ctx.getInteger('nightmare') ?? 0,
    vex: ctx.getInteger('vex') ?? 0,
    punishMini: ctx.getInteger('punishment') ?? 0,
    goodBehavior: ctx.getInteger('behavior') ?? 0,
  };

  if (title !== undefined) {
    changes.title = CLEAR_TITLE.has(title.trim().toLowerCase()) ? null : title;
  }

  return changes;
}

/**
 * Prefix: `profile-edit @member title The Keeper` or
 * `profile-edit @member nightmare +10 vex -5 punishment +7 behavior -2`.
 */
function prefixChanges(tokens) {
  const changes = {
    nightmare: 0,
    vex: 0,
    punishMini: 0,
    goodBehavior: 0,
  };

  if (String(tokens[0] ?? '').toLowerCase() === 'title') {
    const title = tokens.slice(1).join(' ').trim();
    changes.title = !title || CLEAR_TITLE.has(title.toLowerCase()) ? null : title;
    return { changes, problem: null };
  }

  for (let index = 0; index < tokens.length; index += 2) {
    const field = FIELDS[String(tokens[index] ?? '').toLowerCase()];
    const value = parseAmount(tokens[index + 1]);

    if (!field) {
      return {
        changes,
        problem: `\`${tokens[index]}\` is not a field. Use **nightmare**, **vex**, **punishment**, **behavior**, or **title**.`,
      };
    }

    if (value === null) {
      return {
        changes,
        problem: `**${tokens[index]}** needs a number, for example \`+5\` or \`-2\`.`,
      };
    }

    changes[field] += value;
  }

  return { changes, problem: null };
}

function hasChange(changes) {
  return (
    changes.title !== undefined ||
    changes.nightmare !== 0 ||
    changes.vex !== 0 ||
    changes.punishMini !== 0 ||
    changes.goodBehavior !== 0
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('profile-edit')
    .setDescription('Edit a member’s profile title and points')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to edit').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('title')
        .setDescription(`New title (max ${MAX_TITLE_LENGTH}), or "reset" to clear it`)
        .setRequired(false)
        .setMaxLength(MAX_TITLE_LENGTH),
    )
    .addIntegerOption((option) =>
      option
        .setName('nightmare')
        .setDescription('Add or subtract nightmare points, e.g. 10 or -5')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('vex')
        .setDescription('Add or subtract vex points, e.g. 10 or -5')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('punishment')
        .setDescription('Add or subtract punishment mini points (7 = one punishment)')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('behavior')
        .setDescription('Add or subtract good behavior points')
        .setRequired(false),
    ),

  name: 'profile-edit',
  aliases: ['editprofile', 'profile-points'],
  description: 'Edit a member’s profile title and points',
  category: 'Moderation',
  usage:
    'profile-edit <@member> [title <text>] [nightmare <±n>] [vex <±n>] [punishment <±n>] [behavior <±n>]',
  cooldown: 2,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx, client) {
    let user;

    if (ctx.isSlash) {
      user = ctx.getUser('user') ?? ctx.getMember('user')?.user ?? null;
    } else {
      user = await resolveUser(client, ctx.args[0], ctx.message);
    }

    if (!user) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown user',
              `Mention the member or paste their id, for example \`${ctx.isSlash ? '/profile-edit user:@member vex:10' : ':-profile-edit @member vex +10'}\`.`,
            ),
          ],
        }),
      );
      return;
    }

    let changes;

    if (ctx.isSlash) {
      changes = slashChanges(ctx);
    } else {
      const parsed = prefixChanges(ctx.args.slice(1));

      if (parsed.problem) {
        await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid edit', parsed.problem)] }));
        return;
      }

      changes = parsed.changes;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));
    const name = displayNameOf(user, member);

    try {
      ensureExileBackfill(ctx.guildId);
    } catch {
      // Editing still works when the one-time import cannot run.
    }

    const before = getProfile(ctx.guildId, user.id);

    if (!hasChange(changes)) {
      const stats = profileStats(ctx.guildId, user.id, [...ctx.guild.members.cache.keys()]);

      await ctx.reply(
        ephemeral({
          embeds: [
            embed({
              title: `${name} · profile points`,
              description: currentBlock(stats),
              color: COLORS.primary,
              footer: `Rank: ${stats.rank ? `#${stats.rank}` : 'none'} · XP: ${stats.xp}`,
            }),
          ],
        }),
      );
      return;
    }

    if (changes.title !== undefined) {
      setProfileTitle(ctx.guildId, user.id, changes.title);
    }

    const after = addProfilePoints(ctx.guildId, user.id, {
      nightmare: changes.nightmare,
      vex: changes.vex,
      punishMini: changes.punishMini,
      goodBehavior: changes.goodBehavior,
    });

    const lines = summaryLines(before, after, changes);
    const xp = xpFor(after);

    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: `${name} · profile updated`,
            description: lines.join('\n'),
            color: COLORS.success,
            fields: [
              {
                name: 'Now',
                value: currentBlock(after),
              },
            ],
            footer: `XP: ${xp} · Level ${levelFor(xp)} · ${progressFor(xp)} / 100`,
          }),
        ],
      }),
    );
  },
};
