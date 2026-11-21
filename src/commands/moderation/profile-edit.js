import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { errorReply, infoReply, okReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import { displayNameOf } from '../../lib/targets.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import {
  MAX_TITLE_LENGTH,
  addProfilePoints,
  displayedPunishments,
  ensureCoinBackfill,
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
  xp: 'xp',
  experience: 'xp',
  exp: 'xp',
  punishment: 'punishMini',
  punishments: 'punishMini',
  punish: 'punishMini',
  behavior: 'goodBehavior',
  behaviour: 'goodBehavior',
  behavior_points: 'goodBehavior',
  behaviour_points: 'goodBehavior',
  good: 'goodBehavior',
  coins: 'coins',
  coin: 'coins',
};

function summaryLines(before, after, changes, xpBefore = xpFor(before), xpAfter = xpFor(after)) {
  const lines = [];

  if (changes.title !== undefined) {
    lines.push(
      `**اللقب:** ${before.title ?? 'بدون لقب'} → ${after.title ?? 'بدون لقب'}`,
    );
  }

  if (changes.nightmare) {
    lines.push(`**نقاط الكابوس:** ${before.nightmare} → ${after.nightmare}`);
  }

  if (changes.vex) {
    lines.push(`**نقاط فيكس:** ${before.vex} → ${after.vex}`);
  }

  if (changes.xp) {
    lines.push(`**XP:** ${xpBefore} → ${xpAfter}`);
  }

  if (changes.punishMini) {
    lines.push(
      `**نقاط العقوبات:** ${before.punishMini} → ${after.punishMini} ` +
        `(${displayedPunishments(after)} ظاهرة)`,
    );
  }

  if (changes.goodBehavior) {
    lines.push(`**السلوك الحسن:** ${before.goodBehavior} → ${after.goodBehavior}`);
  }

  if (changes.coins) {
    lines.push(`**الكوينز:** ${before.coins} → ${after.coins}`);
  }

  return lines;
}

function currentBlock(profile) {
  const xp = xpFor(profile);

  return [
    `**اللقب:** ${profile.title ?? 'بدون لقب'}`,
    `**الكابوس:** ${profile.nightmare} · **فيكس:** ${profile.vex} · **XP:** ${xp} (مستوى ${levelFor(xp)})`,
    `**العقوبات:** ${displayedPunishments(profile)} (${profile.punishMini} نقطة صغيرة)`,
    `**السلوك الحسن:** ${profile.goodBehavior}`,
    `**الكوينز:** ${profile.coins}`,
  ].join('\n');
}

function parseAmount(value) {
  const number = Number.parseInt(String(value ?? '').replace(/^\+/, ''), 10);
  return Number.isFinite(number) ? number : null;
}

/** XP shown on the card includes the linked bots' points. */
function withLinkedProfile(profile, linked, userId) {
  return {
    ...profile,
    nightmare: Number(profile.nightmare) + (Number(linked?.nightmare?.[userId]) || 0),
    vex: Number(profile.vex) + (Number(linked?.vex?.[userId]) || 0),
  };
}

/** Slash: options are already typed and validated by Discord. */
function slashChanges(ctx) {
  const title = ctx.getString('title');
  const changes = {
    nightmare: ctx.getInteger('nightmare') ?? 0,
    vex: ctx.getInteger('vex') ?? 0,
    xp: ctx.getInteger('xp') ?? 0,
    punishMini: ctx.getInteger('punishment') ?? 0,
    goodBehavior: ctx.getInteger('behavior') ?? 0,
    coins: ctx.getInteger('coins') ?? 0,
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
    xp: 0,
    punishMini: 0,
    goodBehavior: 0,
    coins: 0,
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
        problem: `\`${tokens[index]}\` مو حقل معروف. استخدم **nightmare**، **vex**، **xp**، **punishment**، **behavior**، **coins**، أو **title**.`,
      };
    }

    if (value === null) {
      return {
        changes,
        problem: `**${tokens[index]}** يحتاج رقم، مثل \`+5\` أو \`-2\`.`,
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
    changes.xp !== 0 ||
    changes.punishMini !== 0 ||
    changes.goodBehavior !== 0 ||
    changes.coins !== 0
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('profile-edit')
    .setDescription('عدّل لقب عضو ونقاطه و XP')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو اللي تبي تعدّله').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('title')
        .setDescription(`اللقب الجديد (حد ${MAX_TITLE_LENGTH} حرف)، أو "reset" يمسحه`)
        .setRequired(false)
        .setMaxLength(MAX_TITLE_LENGTH),
    )
    .addIntegerOption((option) =>
      option
        .setName('nightmare')
        .setDescription('زد أو انقص نقاط الكابوس، مثل 10 أو -5')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('vex')
        .setDescription('زد أو انقص نقاط فيكس، مثل 10 أو -5')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('xp')
        .setDescription('زد أو انقص XP مباشرة، مثل 25 أو -10')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('punishment')
        .setDescription('زد أو انقص نقاط العقوبات (7 = عقوبة واحدة)')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('behavior')
        .setDescription('زد أو انقص نقاط السلوك الحسن')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('coins')
        .setDescription('زد أو انقص الكوينز، مثل 25 أو -10')
        .setRequired(false),
    ),

  name: 'profile-edit',
  aliases: ['editprofile', 'profile-points'],
  description: 'عدّل لقب عضو ونقاطه و XP',
  category: 'Moderation',
  usage:
    'profile-edit <@member> [title <text>] [nightmare <±n>] [vex <±n>] [xp <±n>] [punishment <±n>] [behavior <±n>] [coins <±n>]',
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
      await ctx.fail(
        ephemeral(
          errorReply(
            'عضو غير معروف',
            `منشن العضو أو الصق آيدي، مثل \`${ctx.isSlash ? '/profile-edit user:@member vex:10' : ':-profile-edit @member vex +10'}\`.`,
          ),
        ),
      );
      return;
    }

    let changes;

    if (ctx.isSlash) {
      changes = slashChanges(ctx);
    } else {
      const parsed = prefixChanges(ctx.args.slice(1));

      if (parsed.problem) {
        await ctx.fail(ephemeral(errorReply('تعديل غير صحيح', parsed.problem)));
        return;
      }

      changes = parsed.changes;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));
    const name = displayNameOf(user, member);

    let linked = null;

    try {
      linked = client ? await linkedPoints(client, ctx.guildId) : null;
    } catch {
      // Without the linked balances the edit still works on the stored points.
    }

    try {
      ensureExileBackfill(ctx.guildId);
      ensureCoinBackfill(ctx.guildId, linked);
    } catch {
      // Editing still works when the one-time imports cannot run.
    }

    const before = getProfile(ctx.guildId, user.id);

    if (!hasChange(changes)) {
      const stats = profileStats(
        ctx.guildId,
        user.id,
        [...ctx.guild.members.cache.keys()],
        linked,
      );

      await ctx.reply(
        ephemeral(
          infoReply(
            `${name} · نقاط الملف`,
            [
              currentBlock(stats),
              '',
              `**الترتيب:** ${stats.rank ? `#${stats.rank}` : 'ما فيه'} · **XP:** ${stats.xp}`,
            ].join('\n'),
          ),
        ),
      );
      return;
    }

    if (changes.title !== undefined) {
      setProfileTitle(ctx.guildId, user.id, changes.title);
    }

    addProfilePoints(
      ctx.guildId,
      user.id,
      {
        nightmare: changes.nightmare,
        vex: changes.vex,
        xp: changes.xp,
        punishMini: changes.punishMini,
        goodBehavior: changes.goodBehavior,
        coins: changes.coins,
      },
      {
        coinType: 'admin',
        coinDetail: { source: 'profile-edit' },
        actorId: ctx.user.id,
        linked,
      },
    );

    // Reading the profile back settles the punishment toll and any level-up
    // coins, so the confirmation shows the balance the card will show.
    const stats = profileStats(
      ctx.guildId,
      user.id,
      [...ctx.guild.members.cache.keys()],
      linked,
    );
    const after = getProfile(ctx.guildId, user.id);
    const lines = summaryLines(
      before,
      after,
      changes,
      xpFor(withLinkedProfile(before, linked, user.id)),
      xpFor(withLinkedProfile(after, linked, user.id)),
    );

    await ctx.reply(
      ephemeral(
        okReply(
          `${name} · تم التحديث`,
          [
            lines.join('\n'),
            '',
            '**الحين**',
            currentBlock(after),
            '',
            `**XP:** ${stats.xp} · **المستوى** ${stats.level} · **التقدّم** ${stats.progress} / 100 · **الكوينز** ${stats.coins}`,
          ].join('\n'),
        ),
      ),
    );
  },
};
