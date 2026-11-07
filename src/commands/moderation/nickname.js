import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { parseReference, resolveMember } from '../../lib/resolve.js';

const logger = createLogger('nickname');

const MAX_LENGTH = 32;

// `reset` and friends clear the nickname instead of setting it to that word.
const RESET_WORDS = new Set(['reset', 'clear', 'remove', 'none', '-', '_', 'default']);

function ephemeral(payload) {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function reasonFor(ctx) {
  return `Nickname command: ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500);
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_~|>])/g, '\\$1');
}

/**
 * Turns the typed text into `{ value }` for a new nickname or `{ value: null }`
 * for a reset. Empty text means reset, which is how `/nickname` without the
 * option behaves.
 */
function normalizeNickname(raw) {
  const text = String(raw ?? '').trim();

  if (!text || RESET_WORDS.has(text.toLowerCase())) return { value: null };

  if (text.length > MAX_LENGTH) {
    return {
      problem: `Nicknames are limited to **${MAX_LENGTH}** characters — that one is **${text.length}**.`,
    };
  }

  return { value: text };
}

/** The member to rename: the mentioned one, or else the author. */
async function slashTarget(ctx) {
  const user = ctx.getUser('user');
  const text = (ctx.getString('nickname') ?? '').trim();

  if (!user) return { member: ctx.member, text };

  const member =
    ctx.getMember('user') ??
    (await ctx.guild.members.fetch(user.id).catch(() => null));

  return { member, text };
}

async function prefixTarget(ctx) {
  const [first] = ctx.args;
  const ref = first ? parseReference(first) : null;

  if (ref && (ref.kind === 'user' || ref.kind === 'id')) {
    const member = await resolveMember(ctx.guild, first, ctx.message);

    // A member mention or id targets that member; anything else is the author
    // typing a nickname that happens to start with an id-like number.
    if (member) {
      return { member, text: ctx.args.slice(1).join(' ').trim() };
    }
  }

  return { member: ctx.member, text: ctx.args.join(' ').trim() };
}

function apiProblem(error) {
  if (error?.code === 50013) {
    return 'Discord refused the change. I need **Manage Nicknames**, and my highest role must sit above the member’s. The server owner cannot be renamed at all.';
  }

  if (error?.code === 50035) {
    return 'Discord rejected that nickname. Keep it under 32 characters and avoid control characters.';
  }

  if (error?.code === 429 || /rate limit/i.test(String(error?.message))) {
    return 'Discord is rate limiting nickname changes. Wait a minute and try again.';
  }

  return error?.message
    ? `Discord said: ${String(error.message).slice(0, 300)}`
    : 'Something went wrong while changing the nickname.';
}

export default {
  data: new SlashCommandBuilder()
    .setName('nickname')
    .setDescription('Change your nickname, or someone else’s with Manage Nicknames')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Member to rename (defaults to you)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('nickname')
        .setDescription('New nickname — leave empty to reset')
        .setMaxLength(MAX_LENGTH)
        .setRequired(false),
    ),

  name: 'nickname',
  aliases: ['nick'],
  description: 'Change your nickname, or someone else’s with Manage Nicknames',
  category: 'Moderation',
  usage: 'nickname [@member] [name] | nickname [@member] reset',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    // The member fetch and the API call can pass three seconds on a cold cache.
    if (ctx.isSlash) await ctx.defer({ ephemeral: true });

    const { member, text } = ctx.isSlash
      ? await slashTarget(ctx)
      : await prefixTarget(ctx);

    if (!member) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown member',
              'Mention someone in this server, or paste their id, for example `:-nickname @member New Name`.',
            ),
          ],
        }),
      );
      return;
    }

    const self = member.id === ctx.user.id;

    if (!self && !ctx.member?.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Missing permissions',
              'You need **Manage Nicknames** to rename someone else. You can always rename yourself.',
            ),
          ],
        }),
      );
      return;
    }

    const me = ctx.guild.members?.me;

    if (!me) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Cannot rename',
              'I could not read my own server profile. Try again in a moment.',
            ),
          ],
        }),
      );
      return;
    }

    if (!me.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Missing permissions',
              'I need **Manage Nicknames** to change nicknames.',
            ),
          ],
        }),
      );
      return;
    }

    if (member.id === me.id) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'That is me',
              'I cannot rename myself from a command — change my nickname in **Server Settings → Members**.',
            ),
          ],
        }),
      );
      return;
    }

    if (member.id === ctx.guild.ownerId) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Server owner',
              'Discord does not let anyone change the nickname of the server owner.',
            ),
          ],
        }),
      );
      return;
    }

    if (!self) {
      const botTop = me.roles?.highest?.position ?? 0;
      const memberTop = member.roles?.highest?.position ?? 0;

      if (memberTop >= botTop) {
        await ctx.fail(
          ephemeral({
            embeds: [
              errorEmbed(
                'Role too high',
                `${member}'s highest role sits at or above mine, so I cannot rename them. Move my role higher in **Server Settings → Roles**, then try again.`,
              ),
            ],
          }),
        );
        return;
      }
    }

    const parsed = normalizeNickname(text);

    if (parsed.problem) {
      await ctx.fail(
        ephemeral({ embeds: [errorEmbed('Nickname too long', parsed.problem)] }),
      );
      return;
    }

    try {
      await member.setNickname(parsed.value, reasonFor(ctx));
    } catch (error) {
      logger.warn(`Nickname change failed for ${member.id}: ${error.message}`);

      await ctx.fail(
        ephemeral({
          embeds: [errorEmbed('Could not change the nickname', apiProblem(error))],
        }),
      );
      return;
    }

    logger.info(
      `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) set nickname of ${member.id} to ${parsed.value ?? 'reset'}`,
    );

    const who = self ? 'Your nickname' : `The nickname of ${member}`;
    const description = parsed.value
      ? `${who} is now **${escapeMarkdown(parsed.value)}**.`
      : `${who} was reset.`;

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(parsed.value ? 'Nickname updated' : 'Nickname reset', description),
        ],
      }),
    );
  },
};
