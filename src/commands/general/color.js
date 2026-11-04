import {
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { embed, errorEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('color');

// Names are convenient on a phone, where typing "#ff0000" is awkward. Values
// are the usual CSS colours, with a couple of Discord-specific extras.
const NAMED_COLORS = {
  red: 0xff0000,
  crimson: 0xdc143c,
  orange: 0xffa500,
  amber: 0xffbf00,
  gold: 0xffd700,
  yellow: 0xffff00,
  lime: 0x00ff00,
  green: 0x008000,
  emerald: 0x50c878,
  mint: 0x98ff98,
  teal: 0x008080,
  cyan: 0x00ffff,
  aqua: 0x00ffff,
  sky: 0x87ceeb,
  blue: 0x0000ff,
  navy: 0x000080,
  indigo: 0x4b0082,
  purple: 0x800080,
  violet: 0xee82ee,
  magenta: 0xff00ff,
  fuchsia: 0xff00ff,
  pink: 0xffc0cb,
  rose: 0xff007f,
  brown: 0xa52a2a,
  maroon: 0x800000,
  olive: 0x808000,
  white: 0xffffff,
  silver: 0xc0c0c0,
  gray: 0x808080,
  grey: 0x808080,
  black: 0x000000,
  blurple: 0x5865f2,
  discord: 0x5865f2,
};

const USAGE = {
  slash: '/color primary:#ff0000 secondary:#00ff00',
  prefix: ':-color #ff0000 #00ff00',
};

function toColor(value) {
  return {
    value,
    hex: `#${value.toString(16).padStart(6, '0').toUpperCase()}`,
  };
}

/**
 * Accepts #rgb, #rrggbb, 0xrrggbb, bare hex, and the names above.
 * Returns `{ value, hex }` or null. Kept pure so it can be tested without
 * a Discord client.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;

  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const named = NAMED_COLORS[raw];
  if (Number.isInteger(named)) return toColor(named);

  let hex = raw.replace(/^#+/, '');
  if (hex.startsWith('0x')) hex = hex.slice(2);

  if (/^[\da-f]{3}$/.test(hex)) {
    hex = [...hex].map((part) => part + part).join('');
  }

  if (!/^[\da-f]{6}$/.test(hex)) return null;

  return toColor(Number.parseInt(hex, 16));
}

/**
 * Every role the member alone holds, highest first. Integration roles are
 * skipped: they belong to the app that created them and cannot be edited.
 * `counts` comes from Discord's role member-count endpoint and makes the check
 * exact even when the member cache is cold.
 */
export function findPersonalRoles(member, counts = null) {
  return [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .filter((role) => {
      const count = counts?.get?.(role.id);

      if (count !== undefined) return count === 1;

      return role.members.size === 1 && role.members.has(member.id);
    });
}

/**
 * The highest role the member has that nobody else has.
 */
export function findPersonalRole(member, counts = null) {
  return findPersonalRoles(member, counts)[0] ?? null;
}

/**
 * The highest personal role whose position is below `botTop`, so the bot is
 * allowed to edit it. A member can hold several personal roles and only their
 * top one may sit above the bot.
 */
export function findEditablePersonalRole(member, counts = null, botTop = Infinity) {
  return findPersonalRoles(member, counts).find((role) => role.position < botTop) ?? null;
}

/**
 * Resolves the role a member is allowed to recolour, or explains why none can
 * be used. The highest personal role is preferred, but if it sits above the
 * bot the next one it can edit is used instead; refusing outright would leave
 * members with an admin-ish role unable to change any colour at all.
 */
export async function pickColorRole(guild, member) {
  if (!member) {
    return { problem: 'I could not read your server profile. Try again in a moment.' };
  }

  const me = guild.members?.me;

  if (!me) {
    return { problem: 'I could not read my own server profile. Try again in a moment.' };
  }

  const canManage =
    me.permissions?.has(PermissionFlagsBits.ManageRoles) ||
    me.permissions?.has(PermissionFlagsBits.Administrator);

  if (!canManage) {
    return { problem: 'I need the **Manage Roles** permission to change role colors.' };
  }

  let counts = null;

  try {
    counts = (await guild.roles?.fetchMemberCounts?.()) ?? null;
  } catch {
    // Older guilds or a transient API failure: fall back to the member cache.
  }

  if (!counts && (guild.members?.cache?.size ?? 0) < (guild.memberCount ?? 0)) {
    try {
      await guild.members?.fetch?.();
    } catch {
      // Still usable if the cache already covers every role in question.
    }
  }

  const role = findEditablePersonalRole(member, counts, me.roles?.highest?.position ?? 0);

  if (!role) {
    const personal = findPersonalRoles(member, counts);

    if (personal.length === 0) {
      return {
        problem:
          'You do not have an editable **personal role** — every role you have is either shared with someone else or managed by an integration.\n' +
          'Ask an admin to give you a role that nobody else has, then run the command again.',
      };
    }

    return {
      role: personal[0],
      blocked: personal[0],
      problem:
        `**${personal[0].name}** sits at or above my highest role, so I cannot change its colors.\n` +
        'Ask an admin to drag my role above it in **Server Settings → Roles**, then try again.',
    };
  }

  // If a higher personal role exists but is out of reach, say which one was
  // skipped so the member knows why a different role changed.
  const blocked = findPersonalRoles(member, counts).find((candidate) => candidate.id !== role.id) ?? null;

  return { role, blocked };
}

function privatePayload(payload) {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

async function respond(ctx, payload) {
  const body = { ...payload, allowedMentions: { parse: [] } };

  if (ctx.isSlash) return ctx.editReply(body);
  return ctx.reply(body);
}

// Errors release the cooldown: a bad hex code or a blocked role should not
// stop the user from trying again straight away.
function fail(ctx, title, description) {
  return ctx.fail(privatePayload({ embeds: [errorEmbed(title, description)] }));
}

function usageLines(ctx) {
  return ctx.isSlash
    ? `**Usage:** \`${USAGE.slash}\``
    : `**Usage:** \`${USAGE.prefix}\``;
}

function apiProblem(error) {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) {
      return 'Discord says I do not have permission to edit that role. Move my role above it and make sure I have **Manage Roles**.';
    }

    if (error.code === 50035) {
      return 'Discord rejected those colors. Gradient role colors need a boosted server, and both values must be valid.';
    }

    if (error.code === 429 || /rate limit/i.test(error.message)) {
      return 'Discord is rate limiting role changes. Wait a minute and try again.';
    }

    return `Discord said: ${String(error.message).slice(0, 300)}`;
  }

  return error?.message
    ? `Something went wrong: ${String(error.message).slice(0, 300)}`
    : 'Something went wrong while changing the role colors.';
}

export default {
  data: new SlashCommandBuilder()
    .setName('color')
    .setDescription('Change the two colors of your own personal role')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('primary')
        .setDescription('First color: #ff0000, 0xff0000, f00, or a name like red')
        .setMinLength(3)
        .setMaxLength(24)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('secondary')
        .setDescription('Second color: #00ff00, 0x00ff00, 0f0, or a name like green')
        .setMinLength(3)
        .setMaxLength(24)
        .setRequired(true),
    ),

  name: 'color',
  aliases: ['colour', 'colors'],
  description: 'Change the two colors of the highest role that only you have',
  category: 'General',
  usage: 'color <primary> <secondary>',
  cooldown: 30,
  guildOnly: true,

  async execute(ctx) {
    const primaryInput = ctx.isSlash ? ctx.getString('primary') : ctx.args[0];
    const secondaryInput = ctx.isSlash ? ctx.getString('secondary') : ctx.args[1];

    if (!primaryInput || !secondaryInput) {
      await fail(
        ctx,
        'Two colors needed',
        `Give me a first and a second color.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    const primary = parseColor(primaryInput);
    const secondary = parseColor(secondaryInput);

    if (!primary || !secondary) {
      const which = !primary ? 'first' : 'second';
      const bad = String(!primary ? primaryInput : secondaryInput)
        .slice(0, 40)
        .replace(/[`\r\n]/g, ' ');

      await fail(
        ctx,
        'Unknown color',
        `\`${String(bad).slice(0, 40)}\` is not a valid ${which} color.\n\n` +
          'Use a hex code like `#FF0000` or `#F00`, or a name like `red`, `blue`, `purple`.\n\n' +
          usageLines(ctx),
      );
      return;
    }

    // The member-count lookup can take a moment on a large server.
    await ctx.defer({ ephemeral: true });

    const { role, blocked, problem } = await pickColorRole(ctx.guild, ctx.member);

    if (problem) {
      await fail(ctx, 'Cannot change your color', problem);
      return;
    }

    const current = role.colors ?? {
      primaryColor: role.color ?? 0,
      secondaryColor: null,
      tertiaryColor: null,
    };

    if (
      current.primaryColor === primary.value &&
      current.secondaryColor === secondary.value &&
      !current.tertiaryColor
    ) {
      // Nothing changed, so do not hold the cooldown against the user.
      ctx.releaseCooldown();

      await respond(ctx, {
        embeds: [
          embed({
            title: 'Already set',
            description:
              `${role} already uses \`${primary.hex}\` → \`${secondary.hex}\`.\n` +
              'Try two different colors if you want a visible change.',
            color: primary.value,
            footer: 'Only your highest editable personal role can be changed.',
          }),
        ],
      });
      return;
    }

    try {
      const updated = await role.setColors(
        {
          primaryColor: primary.value,
          secondaryColor: secondary.value,
          // A holographic role has a third color; clear it so this really is a
          // two-color gradient.
          tertiaryColor: null,
        },
        `Color command: ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500),
      );

      logger.info(
        `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) set ${role.name} (${role.id}) to ${primary.hex} -> ${secondary.hex}`,
      );

      const same = primary.value === secondary.value;
      const lines = [
        `${role} now uses ${same ? 'a solid color' : 'a gradient'}.`,
        '',
        `**Primary:** \`${primary.hex}\``,
        `**Secondary:** \`${secondary.hex}\``,
      ];

      if (same) {
        lines.push('', 'Both values are the same, so the role will look solid.');
      }

      if (blocked) {
        lines.push(
          '',
          `${blocked} sits above my highest role, so it cannot be changed — I used ${role} instead.`,
        );
      }

      await respond(ctx, {
        embeds: [
          embed({
            title: 'Color updated',
            description: lines.join('\n'),
            color: updated?.colors?.primaryColor ?? primary.value,
            footer: 'Only your highest editable personal role can be changed.',
          }),
        ],
      });
    } catch (error) {
      logger.warn(`Color change failed for ${ctx.user.id} on ${role.id}: ${error.message}`);

      await fail(ctx, 'Could not change the colors', apiProblem(error));
    }
  },
};
