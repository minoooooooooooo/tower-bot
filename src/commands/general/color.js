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
  slash: [
    '/color primary:#ff0000 secondary:#00ff00',
    '/color primary:#ff0000',
    '/color secondary:#00ff00',
    '/color clear:true',
  ],
  prefix: [
    ':-color #ff0000 #00ff00',
    ':-color #ff0000',
    ':-color - #00ff00',
    ':-color clear',
  ],
};

// Words that ask for the default (no) color instead of a value. Both fields
// accept them so `/color primary:clear` works without remembering the option.
const CLEAR_WORDS = new Set(['clear', 'reset', 'none', 'default', 'مسح']);

// Prefix has no optional options, so "-" means "keep this color as it is".
const KEEP_WORDS = new Set(['-', '_', 'keep', 'same']);

const FOOTER = 'Only your highest editable personal role can be changed.';

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
  const examples = ctx.isSlash ? USAGE.slash : USAGE.prefix;

  return ['**Usage:**', ...examples.map((line) => `\`${line}\``)].join('\n');
}

function isClearInput(value) {
  return typeof value === 'string' && CLEAR_WORDS.has(value.trim().toLowerCase());
}

function isKeepInput(value) {
  return typeof value === 'string' && KEEP_WORDS.has(value.trim().toLowerCase());
}

function colorSummary(primaryHex, secondaryHex) {
  return secondaryHex
    ? `\`${primaryHex}\` → \`${secondaryHex}\``
    : `\`${primaryHex}\` (solid)`;
}

function skippedNote(blocked, role) {
  return `${blocked} sits above my highest role, so it cannot be changed — I used ${role} instead.`;
}

function reasonFor(ctx) {
  return `Color command: ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500);
}

function hexOf(value) {
  return toColor(Number(value ?? 0)).hex;
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

/**
 * Resets the role to the default color. Discord treats primary color 0 as "no
 * color", and nulls clear the gradient and holographic third color.
 */
async function clearColors(ctx, role, blocked, current) {
  const already = !current.primaryColor && !current.secondaryColor && !current.tertiaryColor;

  if (already) {
    // Nothing changed, so do not hold the cooldown against the user.
    ctx.releaseCooldown();

    await respond(ctx, {
      embeds: [
        embed({
          title: 'Already clear',
          description: `${role} already uses the default color — there is nothing to clear.`,
          footer: FOOTER,
        }),
      ],
    });
    return;
  }

  try {
    await role.setColors(
      { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
      reasonFor(ctx),
    );

    logger.info(
      `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) cleared ${role.name} (${role.id})`,
    );

    const lines = [`${role} now uses the default color — no gradient.`];

    if (blocked) {
      lines.push('', skippedNote(blocked, role));
    }

    await respond(ctx, {
      embeds: [
        embed({
          title: 'Color cleared',
          description: lines.join('\n'),
          footer: FOOTER,
        }),
      ],
    });
  } catch (error) {
    logger.warn(`Color clear failed for ${ctx.user.id} on ${role.id}: ${error.message}`);

    await fail(ctx, 'Could not clear the colors', apiProblem(error));
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('color')
    .setDescription('Change or clear the colors of your own personal role')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('primary')
        .setDescription('First color, or clear: #ff0000, 0xff0000, f00, red, clear')
        .setMinLength(3)
        .setMaxLength(24)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('secondary')
        .setDescription('Second color for a gradient: #00ff00, 0f0, green (optional)')
        .setMinLength(3)
        .setMaxLength(24)
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName('clear')
        .setDescription('Remove the color and gradient, back to the default color')
        .setRequired(false),
    ),

  name: 'color',
  aliases: ['colour', 'colors'],
  description: 'Change or clear the colors of the highest role that only you have',
  category: 'General',
  usage: 'color [primary] [secondary] | color clear',
  cooldown: 30,
  guildOnly: true,

  async execute(ctx) {
    const args = ctx.isSlash ? [] : ctx.args;
    let primaryInput = ctx.isSlash ? ctx.getString('primary') : args[0];
    let secondaryInput = ctx.isSlash ? ctx.getString('secondary') : args[1];
    const clearFlag = ctx.isSlash ? ctx.getBoolean('clear') === true : false;

    // "-" (or "keep") leaves a color untouched, so prefix can change only the
    // second color: `:-color - #00ff00`.
    if (isKeepInput(primaryInput)) primaryInput = undefined;
    if (isKeepInput(secondaryInput)) secondaryInput = undefined;

    if (!ctx.isSlash && args.length > 2) {
      await fail(
        ctx,
        'Too many values',
        `Give one color, two colors, or \`clear\`.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    const firstIsClear = isClearInput(primaryInput);
    const secondIsClear = isClearInput(secondaryInput);

    if (
      (clearFlag && (primaryInput || secondaryInput)) ||
      (firstIsClear && secondaryInput) ||
      (secondIsClear && primaryInput)
    ) {
      await fail(
        ctx,
        'Pick one',
        `Use colors or \`clear\`, not both.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    const wantsClear = clearFlag || firstIsClear || secondIsClear;

    if (!wantsClear && !primaryInput && !secondaryInput) {
      await fail(
        ctx,
        'Colors needed',
        `Give one color, two colors, or \`clear\`.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    const primary = wantsClear ? null : parseColor(primaryInput);
    const secondary = wantsClear ? null : parseColor(secondaryInput);

    if (!wantsClear && (!primary && primaryInput || !secondary && secondaryInput)) {
      const badFirst = !primary && primaryInput;
      const which = badFirst ? 'first' : 'second';
      const bad = String(badFirst ? primaryInput : secondaryInput)
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

    const current = {
      primaryColor: role.colors?.primaryColor ?? role.color ?? 0,
      secondaryColor: role.colors?.secondaryColor ?? null,
      tertiaryColor: role.colors?.tertiaryColor ?? null,
    };

    if (wantsClear) {
      await clearColors(ctx, role, blocked, current);
      return;
    }

    const nextPrimary = primary ? primary.value : current.primaryColor;
    const nextSecondary = secondary ? secondary.value : current.secondaryColor;

    // A gradient needs a first color. If the role has none yet, a lone second
    // color would be rejected by Discord, so ask for the first one.
    if (secondary && !nextPrimary) {
      await fail(
        ctx,
        'First color needed',
        `**${role.name}** has no first color yet, so give one along with the second.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    if (
      nextPrimary === current.primaryColor &&
      (nextSecondary ?? null) === (current.secondaryColor ?? null) &&
      !current.tertiaryColor
    ) {
      // Nothing changed, so do not hold the cooldown against the user.
      ctx.releaseCooldown();

      await respond(ctx, {
        embeds: [
          embed({
            title: 'Already set',
            description:
              `${role} already uses ${colorSummary(hexOf(nextPrimary), nextSecondary === null ? null : hexOf(nextSecondary))}.\n` +
              'Try different colors if you want a visible change.',
            color: nextPrimary,
            footer: FOOTER,
          }),
        ],
      });
      return;
    }

    const title = !secondary
      ? 'Primary updated'
      : !primary
        ? 'Secondary updated'
        : 'Color updated';

    try {
      const updated = await role.setColors(
        {
          primaryColor: nextPrimary,
          secondaryColor: nextSecondary,
          // A holographic role has a third color; clear it so this really is a
          // two-color gradient.
          tertiaryColor: null,
        },
        reasonFor(ctx),
      );

      logger.info(
        `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) set ${role.name} (${role.id}) to ${hexOf(nextPrimary)} -> ${nextSecondary === null ? 'none' : hexOf(nextSecondary)}`,
      );

      const solid = nextSecondary === null || nextSecondary === nextPrimary;
      const lines = [
        `${role} now uses ${solid ? 'a solid color' : 'a gradient'}.`,
        '',
        `**Primary:** \`${hexOf(nextPrimary)}\`${primary ? '' : ' _(kept)_'}`,
      ];

      if (nextSecondary === null) {
        lines.push('**Secondary:** _none_');
      } else {
        lines.push(
          `**Secondary:** \`${hexOf(nextSecondary)}\`${secondary ? '' : ' _(kept)_'}`,
        );
      }

      if (nextSecondary !== null && nextSecondary === nextPrimary) {
        lines.push('', 'Both values are the same, so the role will look solid.');
      }

      if (blocked) {
        lines.push('', skippedNote(blocked, role));
      }

      await respond(ctx, {
        embeds: [
          embed({
            title,
            description: lines.join('\n'),
            color: updated?.colors?.primaryColor ?? nextPrimary,
            footer: FOOTER,
          }),
        ],
      });
    } catch (error) {
      logger.warn(`Color change failed for ${ctx.user.id} on ${role.id}: ${error.message}`);

      await fail(ctx, 'Could not change the colors', apiProblem(error));
    }
  },
};
