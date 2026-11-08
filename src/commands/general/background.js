import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { resolveUser } from '../../lib/resolve.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import {
  BACKGROUNDS,
  CUSTOM_ID,
  CUSTOM_LEVEL,
  WallpaperError,
  backgroundById,
  customWallpaperPath,
  deleteCustomWallpaper,
  findBackground,
  hasCustomWallpaper,
  isBackgroundUnlocked,
  nextBackground,
  pointsForLevel,
  resolveBackground,
  saveCustomWallpaper,
  unlockedBackgrounds,
} from '../../services/profile-backgrounds.js';
import {
  getProfile,
  profileLevel,
  setProfileBackground,
} from '../../services/profile-store.js';

const logger = createLogger('background');

const SUBCOMMANDS = new Set(['list', 'set', 'custom', 'reset']);

const SUBCOMMAND_ALIASES = {
  show: 'list',
  view: 'list',
  designs: 'list',
  themes: 'list',
  use: 'set',
  choose: 'set',
  pick: 'set',
  select: 'set',
  upload: 'custom',
  wallpaper: 'custom',
  remove: 'reset',
  clear: 'reset',
  delete: 'reset',
};

const DEFAULT_WORDS = new Set(['default', 'classic', 'original', 'none', 'off']);
const CUSTOM_WORDS = new Set(['custom', 'wallpaper', 'own', 'upload']);

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

/** Personal settings read better as a private slash reply; prefix stays public. */
function respond(ctx, payload) {
  return ctx.reply(ctx.isSlash ? ephemeral(payload) : payload);
}

function formatPoints(points) {
  return Number(points).toLocaleString('en-US');
}

/** Prefix commands may name the subcommand, or start straight with a design. */
function subcommandOf(ctx) {
  if (ctx.isSlash) return ctx.getSubcommand() ?? 'list';

  const raw = String(ctx.args[0] ?? '').toLowerCase();
  if (!raw) return 'list';

  const mapped = SUBCOMMAND_ALIASES[raw] ?? raw;
  return SUBCOMMANDS.has(mapped) ? mapped : 'set';
}

function prefixRest(ctx) {
  const raw = String(ctx.args[0] ?? '').toLowerCase();
  const mapped = SUBCOMMAND_ALIASES[raw] ?? raw;
  return SUBCOMMANDS.has(mapped) ? ctx.args.slice(1) : ctx.args;
}

async function levelOf(ctx, client, userId) {
  // Linked-bot points count toward the level exactly as they do on the card.
  const linked = await linkedPoints(client, ctx.guildId);
  return profileLevel(ctx.guildId, userId, linked);
}

function attachmentOf(ctx) {
  return (
    ctx.getAttachment('image') ??
    ctx.message?.attachments?.first?.() ??
    null
  );
}

function selectionState(ctx, stored, level, hasCustom) {
  const selected = resolveBackground({
    selected: stored.background,
    level,
    hasCustom,
    customPath: hasCustom ? customWallpaperPath(ctx.guildId, ctx.user.id) : null,
  });

  const requestedTier = backgroundById(stored.background);
  const lockedTier =
    requestedTier && !isBackgroundUnlocked(requestedTier, level) ? requestedTier : null;
  const customMissing = stored.background === CUSTOM_ID && !hasCustom;

  return { selected, lockedTier, customMissing };
}

function listEmbed(ctx, level, stored, hasCustom) {
  const { selected, lockedTier, customMissing } = selectionState(ctx, stored, level, hasCustom);
  const unlocked = new Set(unlockedBackgrounds(level).map((background) => background.id));

  const lines = BACKGROUNDS.map((background) => {
    const current =
      stored.background === background.id || (!stored.background && background.id === 'default');
    const mark = current ? '➡️' : unlocked.has(background.id) ? '✅' : '🔒';
    const levelText = background.id === 'default' ? 'always' : `level ${background.level}`;
    const lock = unlocked.has(background.id)
      ? ''
      : ` · ${formatPoints(pointsForLevel(background.level))} points`;

    return `${mark} **${background.name}** — ${levelText}${lock}`;
  });

  const customMark = stored.background === CUSTOM_ID ? '➡️' : hasCustom || level >= CUSTOM_LEVEL ? '✅' : '🔒';
  const customText = hasCustom
    ? 'set — attach a new image to replace it'
    : level >= CUSTOM_LEVEL
      ? `unlocked — upload one with \`${ctx.isSlash ? '/background custom' : ':-background custom'}\``
      : `level ${CUSTOM_LEVEL} · ${formatPoints(pointsForLevel(CUSTOM_LEVEL))} points`;

  lines.push(`${customMark} **Custom wallpaper** — ${customText}`);

  const shown = selected.id === CUSTOM_ID ? 'Custom wallpaper' : selected.name;
  const selectedNote = lockedTier
    ? `\nYour saved pick **${lockedTier.name}** is locked at level ${level}, so the Classic card is shown until you level up.`
    : customMissing
      ? '\nYour custom wallpaper file is missing, so the Classic card is shown.'
      : '';

  const next = nextBackground(level);

  return embed({
    title: 'Profile backgrounds',
    description:
      `You are **level ${level}**. A new design unlocks every 5 levels, and the classic card is always available.` +
      selectedNote,
    color: COLORS.primary,
    fields: [
      { name: 'Selected', value: `**${shown}**`, inline: true },
      {
        name: 'Designs',
        value: `${unlocked.size} of ${BACKGROUNDS.length} unlocked`,
        inline: true,
      },
      {
        name: 'Next design',
        value: next
          ? `**${next.name}** at level ${next.level} · ${formatPoints(pointsForLevel(next.level))} points`
          : level >= CUSTOM_LEVEL
            ? 'Everything is unlocked.'
            : `**Custom wallpaper** at level ${CUSTOM_LEVEL} · ${formatPoints(pointsForLevel(CUSTOM_LEVEL))} points`,
        inline: false,
      },
      { name: 'Ladder', value: lines.join('\n'), inline: false },
    ],
    footer: `Choose with ${ctx.isSlash ? '/background set design:' : ':-background set '}<name or level>`,
  });
}

async function handleList(ctx, client) {
  const level = await levelOf(ctx, client, ctx.user.id);
  const stored = getProfile(ctx.guildId, ctx.user.id);
  const hasCustom = hasCustomWallpaper(ctx.guildId, ctx.user.id);

  const payload = { embeds: [listEmbed(ctx, level, stored, hasCustom)] };
  await respond(ctx, payload);
}

async function handleSet(ctx, client, query) {
  const raw = String(query ?? '').trim();
  const level = await levelOf(ctx, client, ctx.user.id);

  if (!raw) {
    await respond(ctx, {
      embeds: [
        errorEmbed(
          'Choose a design',
          `Use \`${ctx.isSlash ? '/background set design:' : ':-background set '}<name or level>\`, for example \`15\`, \`Tide\`, \`default\` or \`custom\`.`,
        ),
      ],
    });
    return;
  }

  const word = raw.toLowerCase();

  if (DEFAULT_WORDS.has(word)) {
    setProfileBackground(ctx.guildId, ctx.user.id, null);
    await respond(ctx, {
      embeds: [successEmbed('Background changed', 'Your card is back to **Classic**.')],
    });
    return;
  }

  if (CUSTOM_WORDS.has(word)) {
    if (!hasCustomWallpaper(ctx.guildId, ctx.user.id)) {
      await respond(ctx, {
        embeds: [
          errorEmbed(
            'No custom wallpaper yet',
            `Upload one first with \`${ctx.isSlash ? '/background custom image:<file>' : ':-background custom'}\` (level ${CUSTOM_LEVEL}+).`,
          ),
        ],
      });
      return;
    }

    setProfileBackground(ctx.guildId, ctx.user.id, CUSTOM_ID);
    await respond(ctx, {
      embeds: [successEmbed('Background changed', 'Your custom wallpaper is now on your card.')],
    });
    return;
  }

  const background = findBackground(raw);

  if (!background) {
    await respond(ctx, {
      embeds: [
        errorEmbed(
          'Unknown design',
          `Run \`${ctx.isSlash ? '/background' : ':-background'}\` to see the ladder. You can type a name or a level.`,
        ),
      ],
    });
    return;
  }

  if (!isBackgroundUnlocked(background, level)) {
    await respond(ctx, {
      embeds: [
        errorEmbed(
          'Still locked',
          `**${background.name}** unlocks at level **${background.level}** ` +
            `(${formatPoints(pointsForLevel(background.level))} points). You are level ${level}.`,
        ),
      ],
    });
    return;
  }

  setProfileBackground(ctx.guildId, ctx.user.id, background.id);
  await respond(ctx, {
    embeds: [
      successEmbed(
        'Background changed',
        `**${background.name}** is now on your card. Use \`${ctx.isSlash ? '/profile' : ':-profile'}\` to see it.`,
      ),
    ],
  });
}

async function handleCustom(ctx, client, attachment) {
  const level = await levelOf(ctx, client, ctx.user.id);
  const hasCustom = hasCustomWallpaper(ctx.guildId, ctx.user.id);
  const unlocked = level >= CUSTOM_LEVEL || hasCustom;

  if (!attachment) {
    await respond(ctx, {
      embeds: [
        unlocked
          ? infoEmbed(
              'Custom wallpaper',
              hasCustom
                ? 'Attach a new image to replace your wallpaper. It is cropped to the card size automatically.'
                : 'Attach a PNG, JPEG, WebP or GIF image. It is cropped to the card size automatically.',
            )
          : errorEmbed(
              'Still locked',
              `Custom wallpapers unlock at level **${CUSTOM_LEVEL}** ` +
                `(${formatPoints(pointsForLevel(CUSTOM_LEVEL))} points). You are level ${level}.`,
            ),
      ],
    });
    return;
  }

  if (!unlocked) {
    await respond(ctx, {
      embeds: [
        errorEmbed(
          'Still locked',
          `Custom wallpapers unlock at level **${CUSTOM_LEVEL}** ` +
            `(${formatPoints(pointsForLevel(CUSTOM_LEVEL))} points). You are level ${level}.`,
        ),
      ],
    });
    return;
  }

  // Downloading, decoding and re-encoding can pass Discord's three-second
  // acknowledgement window. The result is a personal setting, so keep the
  // slash reply private.
  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const saved = await saveCustomWallpaper(ctx.guildId, ctx.user.id, attachment);
    setProfileBackground(ctx.guildId, ctx.user.id, CUSTOM_ID);

    const payload = {
      embeds: [
        successEmbed(
          'Custom wallpaper set',
          `Stored at ${saved.sourceWidth}x${saved.sourceHeight}, cropped to the card. ` +
            `Run \`${ctx.isSlash ? '/profile' : ':-profile'}\` to see it.`,
        ),
      ],
    };

    if (ctx.isSlash) await ctx.editReply(payload);
    else await ctx.reply(payload);
  } catch (error) {
    if (error instanceof WallpaperError) {
      await ctx.fail({ embeds: [errorEmbed('Could not use that image', error.message)] });
      return;
    }

    logger.error(`Could not save the wallpaper for ${ctx.user.id}`, error);
    await ctx.fail({
      embeds: [
        errorEmbed('Could not save the wallpaper', 'The image could not be stored. Try again in a moment.'),
      ],
    });
  }
}

async function resetTarget(ctx, client) {
  if (ctx.isSlash) return ctx.getUser('user') ?? ctx.user;

  const token = prefixRest(ctx)[0];
  if (!token) return ctx.user;

  return resolveUser(client, token, ctx.message);
}

async function handleReset(ctx, client) {
  const target = await resetTarget(ctx, client);

  if (!target) {
    await respond(ctx, {
      embeds: [errorEmbed('Unknown member', 'Mention the member or paste their id.')],
    });
    return;
  }

  if (target.id !== ctx.user.id) {
    const allowed = ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild);

    if (!allowed) {
      await respond(ctx, {
        embeds: [
          errorEmbed('Not allowed', 'Only members with **Manage Server** can reset someone else’s background.'),
        ],
      });
      return;
    }
  }

  setProfileBackground(ctx.guildId, target.id, null);
  await deleteCustomWallpaper(ctx.guildId, target.id);

  await respond(ctx, {
    embeds: [
      successEmbed(
        'Background reset',
        target.id === ctx.user.id
          ? 'Your card is back to **Classic** and your custom wallpaper was removed.'
          : `<@${target.id}>’s card is back to **Classic** and their custom wallpaper was removed.`,
      ),
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('background')
    .setDescription('Choose or upload your profile-card background')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show every design, your level and the next unlock'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Use a design you have unlocked')
        .addStringOption((option) =>
          option
            .setName('design')
            .setDescription('Name or level: 15, Tide, default, custom')
            .setRequired(true)
            .setMaxLength(40),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('custom')
        .setDescription(`Upload your own wallpaper (level ${CUSTOM_LEVEL}+)`)
        .addAttachmentOption((option) =>
          option
            .setName('image')
            .setDescription('PNG, JPEG, WebP or GIF. Cropped to the card automatically.')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Return to the classic card and delete a custom wallpaper')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Admin: reset someone else (Manage Server)')
            .setRequired(false),
        ),
    ),

  name: 'background',
  aliases: ['bg', 'theme', 'wallpaper'],
  description: 'Choose or upload your profile-card background',
  category: 'General',
  usage: 'background [list | set <design> | custom | reset]',
  cooldown: 4,
  guildOnly: true,

  async execute(ctx, client) {
    const subcommand = subcommandOf(ctx);

    switch (subcommand) {
      case 'set': {
        const query = ctx.isSlash ? ctx.getString('design') : prefixRest(ctx).join(' ');
        return handleSet(ctx, client, query);
      }
      case 'custom':
        return handleCustom(ctx, client, attachmentOf(ctx));
      case 'reset':
        return handleReset(ctx, client);
      default:
        return handleList(ctx, client);
    }
  },
};

