import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('clear');

const MAX_AMOUNT = 1000;
const PAGE_SIZE = 100;
const MAX_SCAN = 2000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

/** How long a prefix run leaves its command and confirmation visible. */
const PREFIX_LIFETIME_MS = 2000;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

// `<@123>`, `<@!123>` and `<@&123>` — the last one is a role, not a member.
const MENTION = /^<@([!&]?)(\d{17,20})>$/;
const RAW_ID = /^\d{17,20}$/;

/**
 * Classifies one prefix token. `{ user }` for a member reference, `{ reason }`
 * for a role mention (so the caller can explain instead of silently dropping
 * the filter), and null for anything that is not a member reference at all.
 */
function parseUserToken(ctx, token) {
  const mention = MENTION.exec(token);

  if (mention) {
    if (mention[1] === '&') return { reason: 'role' };

    const id = mention[2];
    const known = ctx.message?.mentions?.users?.get?.(id);

    return { user: known ?? { id, username: id, bot: false } };
  }

  if (RAW_ID.test(token)) {
    return {
      user: ctx.client?.users?.cache?.get(token) ?? { id: token, username: token, bot: false },
    };
  }

  return null;
}

/**
 * Prefix args never include the command name — `messageCreate` splits it off
 * before building the context — so every token here is a real argument.
 * Amount and member may be given in either order.
 */
function parseInput(ctx) {
  if (ctx.isSlash) {
    return { amount: ctx.getInteger('amount'), user: ctx.getUser('user') ?? null, problem: null };
  }

  let amount = null;
  let user = null;

  for (const token of ctx.args) {
    const parsed = parseUserToken(ctx, token);

    // A role mention cannot be filtered on. Refuse rather than quietly
    // clearing messages from everyone.
    if (parsed?.reason === 'role') {
      return {
        amount,
        user,
        problem: 'That is a role, not a member. Ping the member whose messages you want removed.',
      };
    }

    if (parsed?.user) {
      user ??= parsed.user;
      continue;
    }

    if (amount === null && /^\d+$/.test(token)) {
      amount = Number.parseInt(token, 10);
    }
  }

  return { amount, user, problem: null };
}

/**
 * Walks history newest-first until `amount` recent messages match the optional
 * author filter. Stops at MAX_SCAN so a sparse filter cannot page forever.
 * `excludeId` is the invoking command message's id, which is never deleted.
 */
async function collectMessages(channel, amount, user, excludeId = null) {
  const cutoff = Date.now() - TWO_WEEKS_MS;
  const maxScan = Math.min(amount * 10 + 100, MAX_SCAN);
  const messages = [];
  let before;
  let scanned = 0;
  let hitOld = false;

  while (messages.length < amount && scanned < maxScan) {
    const limit = Math.min(PAGE_SIZE, maxScan - scanned);
    const batch = await channel.messages.fetch({
      limit,
      ...(before ? { before } : {}),
    });

    if (batch.size === 0) break;

    // Newest first: once the newest message in a page is too old, everything
    // after it is older too.
    if (batch.first().createdTimestamp < cutoff) {
      hitOld = true;
      break;
    }

    for (const message of batch.values()) {
      scanned += 1;

      if (message.createdTimestamp < cutoff) {
        hitOld = true;
        continue;
      }

      // `:-clear 1` must remove the message above the command, not the command.
      if (excludeId && message.id === excludeId) continue;

      if (user && message.author.id !== user.id) continue;

      messages.push(message);
      if (messages.length >= amount) break;
    }

    before = batch.last().id;

    if (batch.size < limit) break;
    if (batch.last().createdTimestamp < cutoff) {
      hitOld = true;
      break;
    }
  }

  return { messages: messages.slice(0, amount), hitOld, scanned, scanLimit: maxScan };
}

async function deleteMessages(channel, messages) {
  let deleted = 0;

  // Discord caps bulk delete at 100 messages per request.
  for (let index = 0; index < messages.length; index += 100) {
    const chunk = messages.slice(index, index + 100);

    try {
      const result = await channel.bulkDelete(chunk, true);
      deleted += result.size;
    } catch (error) {
      logger.warn(`Bulk delete failed for ${chunk.length} message(s): ${error.message}`);
    }
  }

  return deleted;
}

/**
 * Prefix and alias runs leave two traces in the channel: the command itself and
 * the confirmation. Both are removed a moment after the clear, so a purge does
 * not leave a "cleared" banner behind. Slash replies are ephemeral, so nothing
 * is scheduled for them.
 */
function tidyPrefixRun(...messages) {
  const timer = setTimeout(() => {
    for (const message of messages) {
      if (!message?.deletable) continue;

      message.delete().catch((error) => {
        logger.debug(`Could not delete a clear message: ${error.message}`);
      });
    }
  }, PREFIX_LIFETIME_MS);

  // Never keep the process alive just to delete these two messages.
  timer.unref?.();
}

function confirmation({ deleted, found, amount, user, channel, hitOld, scanned, scanLimit }) {
  const target = user ? `<@${user.id}>` : null;
  const lines = [];

  if (deleted > 0) {
    lines.push(
      `Deleted **${deleted}** message${deleted === 1 ? '' : 's'}${
        target ? ` from ${target}` : ''
      } in ${channel}.`,
    );
  } else {
    lines.push(
      target
        ? `No recent messages from ${target} were found in ${channel}.`
        : `No recent messages were found in ${channel}.`,
    );
  }

  if (deleted > 0 && found < amount) {
    lines.push(`Only **${found}** matching message${found === 1 ? '' : 's'} were available.`);
  }

  if (found > deleted) {
    lines.push(`**${found - deleted}** message${found - deleted === 1 ? '' : 's'} could not be deleted.`);
  }

  if (hitOld) {
    lines.push("Messages older than 14 days are skipped — Discord does not allow bulk-deleting them.");
  }

  if (scanned >= scanLimit && found < amount) {
    lines.push(`Stopped after scanning ${scanned} messages.`);
  }

  return embed({
    title: deleted > 0 ? 'Messages cleared' : 'Nothing to clear',
    description: lines.join('\n'),
    color: deleted > 0 ? COLORS.success : COLORS.muted,
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete recent messages in this channel')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('How many messages to delete (1-1000)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_AMOUNT),
    )
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Only delete messages from this member')
        .setRequired(false),
    ),

  name: 'clear',
  aliases: ['purge', 'prune'],
  description: 'Delete recent messages in this channel, optionally from one member',
  category: 'Moderation',
  usage: 'clear <amount> [user]',
  cooldown: 5,
  guildOnly: true,
  permissions: ['ManageMessages'],

  async execute(ctx) {
    if (typeof ctx.channel?.bulkDelete !== 'function') {
      await ctx.reply(
        ephemeral({
          embeds: [errorEmbed('Unsupported channel', 'Messages can only be cleared in a server text channel.')],
        }),
      );
      return;
    }

    const input = parseInput(ctx);

    if (input.problem) {
      await ctx.reply(ephemeral({ embeds: [errorEmbed('Unknown member', input.problem)] }));
      return;
    }

    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_AMOUNT) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Invalid amount',
              `Give a whole number from 1 to ${MAX_AMOUNT}, for example \`clear 100\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const me = ctx.guild.members.me;
    const permissions = ctx.channel.permissionsFor(me);

    if (
      !permissions?.has(PermissionFlagsBits.ManageMessages) ||
      !permissions?.has(PermissionFlagsBits.ReadMessageHistory)
    ) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Missing permissions',
              'I need **Manage Messages** and **Read Message History** in this channel.',
            ),
          ],
        }),
      );
      return;
    }

    // Slash interactions must be acknowledged within 3 seconds; deleting can
    // take longer. The prefix path makes this a no-op.
    await ctx.defer({ ephemeral: true });

    let messages;
    let hitOld = false;
    let scanned = 0;
    let scanLimit = MAX_SCAN;

    try {
      ({ messages, hitOld, scanned, scanLimit } = await collectMessages(
        ctx.channel,
        input.amount,
        input.user,
        ctx.message?.id ?? null,
      ));
    } catch (error) {
      logger.warn(`Could not read history in #${ctx.channel.name}: ${error.message}`);
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed('Could not read messages', 'I was unable to fetch this channel\'s history.'),
          ],
        }),
      );
      return;
    }

    const deleted = await deleteMessages(ctx.channel, messages);
    const body = {
      allowedMentions: { parse: [] },
      embeds: [
        confirmation({
          deleted,
          found: messages.length,
          amount: input.amount,
          user: input.user,
          channel: ctx.channel,
          hitOld,
          scanned,
          scanLimit,
        }),
      ],
    };

    if (ctx.isSlash) {
      await ctx.editReply(body);
    } else {
      const sent = await ctx.send(body);
      tidyPrefixRun(ctx.message, sent);
    }
  },
};
