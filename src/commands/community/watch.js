import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { ephemeral, errorReply, infoReply, okReply } from '../../lib/replies.js';
import {
  MAX_TERM_LENGTH,
  MAX_WATCH_TERMS,
  MIN_TERM_LENGTH,
  addIgnoredChannel,
  addWatchTerm,
  clearWatchTerms,
  countTerms,
  findTerm,
  getWatchChannelId,
  listIgnoredChannels,
  listWatchTerms,
  removeIgnoredChannel,
  removeWatchTerm,
  setWatchChannelId,
} from '../../services/watch-store.js';
import { invalidateWatchCache } from '../../services/watch.js';

const logger = createLogger('watch');

const MAX_SHOWN = 30;
const OFF_WORDS = ['off', 'none', 'clear', 'disable'];

async function requireModerator(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة الرسائل** عشان تدير تنبيهات الكلمات.')),
  );

  return false;
}

async function requireAdmin(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(
      errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تختار وين تنكتب تنبيهات الكلمات.'),
    ),
  );

  return false;
}

function extractTerm(ctx) {
  if (ctx.isSlash) return (ctx.getString('keyword') ?? '').trim();

  const [action, ...rest] = ctx.args;

  if (!['add', 'remove', 'delete', 'clear', 'list', 'test', 'channel', 'ignore', 'unignore', 'ignored'].includes(action)) {
    return [action, ...rest].join(' ').trim();
  }

  return rest.join(' ').trim();
}

function prefixChannelArg(ctx) {
  return ctx.args.slice(1).join(' ').trim();
}

/** Case-insensitive name lookup that works on a Collection or a plain Map. */
function findCachedChannel(guild, name, predicate = () => true) {
  const wanted = name.toLowerCase();

  for (const channel of guild.channels.cache.values()) {
    if (channel.name?.toLowerCase() === wanted && predicate(channel)) return channel;
  }

  return null;
}

/** Like resolvePrefixChannel, but categories and voice channels are allowed. */
async function resolvePrefixAnyChannel(ctx, raw) {
  const cleaned = raw.replace(/^<#/, '').replace(/>$/, '').trim();

  if (!cleaned) return null;

  if (/^\d{15,20}$/.test(cleaned)) {
    return (
      ctx.guild.channels.cache.get(cleaned) ??
      (await ctx.guild.channels.fetch(cleaned).catch(() => null))
    );
  }

  return findCachedChannel(ctx.guild, cleaned.replace(/^#/, ''));
}

async function resolvePrefixChannel(ctx, raw) {
  const cleaned = raw.replace(/^<#/, '').replace(/>$/, '').trim();

  if (!cleaned) return null;

  if (/^\d{15,20}$/.test(cleaned)) {
    return (
      ctx.guild.channels.cache.get(cleaned) ??
      (await ctx.guild.channels.fetch(cleaned).catch(() => null))
    );
  }

  return findCachedChannel(ctx.guild, cleaned.replace(/^#/, ''), (channel) =>
    channel.isTextBased?.(),
  );
}

async function requireSendableChannel(ctx, channel) {
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'مو قناة نصية',
          'اختر قناة عادية في السيرفر، مثل `/watch channel #mod-log`.',
        ),
      ),
    );
    return false;
  }

  const me = ctx.guild?.members?.me;
  const permissions = me ? channel.permissionsFor(me) : null;

  if (
    permissions &&
    !permissions.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])
  ) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما أقدر أنشر هناك',
          `أحتاج **عرض القنوات** و**إرسال الرسائل** و**إرفاق الروابط** في ${channel}.`,
        ),
      ),
    );
    return false;
  }

  return true;
}

function channelSummary(ctx) {
  const channelId = getWatchChannelId(ctx.guildId);

  return channelId
    ? { channelId, text: `التنبيهات تنكتب في <#${channelId}>.` }
    : { channelId: null, text: '⚠️ ما فيه قناة تنبيه — شغّل `/watch channel #channel`.' };
}

function listPayload(ctx) {
  const terms = listWatchTerms(ctx.guildId);
  const { channelId, text } = channelSummary(ctx);

  if (terms.length === 0) {
    return embed({
      title: 'ما فيه كلمات مراقبة بعد',
      description: [
        `أضف واحدة بـ \`${ctx.isSlash ? '/watch add keyword:leak' : ':-watch add leak'}\`.`,
        'القائمة مشتركة: أي مشرف يضيف أو يحذف كلمة، وكل التنبيهات تنروح لقناة وحدة.',
        '',
        channelId ? text : `⚠️ ما فيه قناة تنبيه بعد — شغّل \`${ctx.isSlash ? '/watch channel' : ':-watch channel'} #channel\`.`,
      ].join('\n'),
      color: COLORS.muted,
    });
  }

  const shown = terms.slice(0, MAX_SHOWN);
  const lines = shown.map(
    (entry) => `\u200E- \`${entry.term}\` — أضافها <@${entry.createdBy}>`,
  );

  if (terms.length > shown.length) lines.push(`…و ${terms.length - shown.length} غيرها`);

  return embed({
    title: `الكلمات المراقبة (${terms.length}/${MAX_WATCH_TERMS})`,
    description: lines.join('\n'),
    footer: channelId
      ? `${text} كل تنبيه فيه رابط قفز.`
      : 'ما فيه قناة تنبيه — التنبيهات ما تنكتب لين تختار وحدة.',
    color: channelId ? COLORS.primary : COLORS.warning,
  });
}

async function handleAdd(ctx) {
  if (!(await requireModerator(ctx))) return;

  const term = extractTerm(ctx);

  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'كلمة غير صحيحة',
          `استخدم من ${MIN_TERM_LENGTH} إلى ${MAX_TERM_LENGTH} حرف، مثل \`/watch add keyword:leak\`.`,
        ),
      ),
    );
    return;
  }

  const result = addWatchTerm(ctx.guildId, ctx.user.id, term);

  if (!result.added && result.reason === 'limit') {
    await ctx.fail(
      ephemeral(
        errorReply(
          'قائمة الكلمات مليانة',
          `السيرفر يراقب ${countTerms(ctx.guildId)} كلمة من قبل (الحد ${MAX_WATCH_TERMS}). احذف واحدة أول.`,
        ),
      ),
    );
    return;
  }

  if (!result.added && result.reason === 'duplicate') {
    await ctx.reply(
      ephemeral(infoReply('مراقَبة أصلًا', `\`${result.term}\` موجودة في القائمة.`)),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  const channelId = getWatchChannelId(ctx.guildId);

  await ctx.reply(
    ephemeral(
      okReply(
        'انضافت الكلمة',
        channelId
          ? `بنشر تنبيه في <#${channelId}> كل ما تطلع \`${term}\` في أي مكان بالسيرفر.`
          : `\`${term}\` صارت مراقَبة، لكن ما فيه قناة تنبيه بعد — شغّل \`/watch channel #channel\` وإلا ما تنكتب التنبيهات.`,
      ),
    ),
  );
}

async function handleRemove(ctx) {
  if (!(await requireModerator(ctx))) return;

  const term = extractTerm(ctx);

  if (!term) {
    await ctx.fail(
      ephemeral(
        errorReply('أي كلمة؟', 'استخدم `/watch remove keyword:word` أو `:-watch remove word`.'),
      ),
    );
    return;
  }

  const existing = findTerm(ctx.guildId, term);
  const removed = existing ? removeWatchTerm(ctx.guildId, term) : 0;

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral(
      removed > 0
        ? okReply('انحذفت الكلمة', `\`${existing.term}\` ما عادت مراقَبة.`)
        : infoReply('مو في القائمة', `\`${term}\` ما كانت مراقَبة.`),
    ),
  );
}

async function handleClear(ctx) {
  if (!(await requireModerator(ctx))) return;

  const removed = clearWatchTerms(ctx.guildId);

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral(
      removed > 0
        ? okReply('انمسحت الكلمات', `انحذفت ${removed} كلمة.`)
        : infoReply('ما فيه شي ينمسح', 'قائمة الكلمات فاضية أصلًا.'),
    ),
  );
}

async function handleChannel(ctx) {
  if (!(await requireAdmin(ctx))) return;

  if (ctx.isSlash) {
    const channel = ctx.getChannel('channel');

    if (!channel) {
      setWatchChannelId(ctx.guildId, null);
      invalidateWatchCache(ctx.guildId);

      await ctx.reply(
        ephemeral(
          okReply('التنبيهات مقفّلة', 'ما فيه قناة بتستقبل تنبيهات الكلمات لين تنضبط وحدة.'),
        ),
      );
      return;
    }

    if (!(await requireSendableChannel(ctx, channel))) return;

    setWatchChannelId(ctx.guildId, channel.id);
    invalidateWatchCache(ctx.guildId);

    await ctx.reply(
      ephemeral(okReply('انحفظت قناة التنبيه', `تنبيهات الكلمات بتنكتب في ${channel}.`)),
    );
    return;
  }

  const raw = prefixChannelArg(ctx);

  if (!raw || OFF_WORDS.includes(raw.toLowerCase())) {
    setWatchChannelId(ctx.guildId, null);
    invalidateWatchCache(ctx.guildId);

    await ctx.reply(
      ephemeral(
        okReply('التنبيهات مقفّلة', 'ما فيه قناة بتستقبل تنبيهات الكلمات لين تنضبط وحدة.'),
      ),
    );
    return;
  }

  const channel = await resolvePrefixChannel(ctx, raw).catch(() => null);

  if (!channel) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'قناة غير معروفة',
          `ما لقيت \`${raw}\`. منشنها كـ \`#channel\` أو الصق آيدي القناة.`,
        ),
      ),
    );
    return;
  }

  if (!(await requireSendableChannel(ctx, channel))) return;

  setWatchChannelId(ctx.guildId, channel.id);
  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral(okReply('انحفظت قناة التنبيه', `تنبيهات الكلمات بتنكتب في ${channel}.`)),
  );
}

async function handleTest(ctx) {
  if (!(await requireModerator(ctx))) return;

  const channelId = getWatchChannelId(ctx.guildId);

  if (!channelId) {
    await ctx.fail(
      ephemeral(
        errorReply('ما فيه قناة تنبيه', 'شغّل `/watch channel #channel` أول، وبعدها جرّب.'),
      ),
    );
    return;
  }

  let channel;

  try {
    channel = await ctx.guild.channels.fetch(channelId);
  } catch (error) {
    logger.warn(`Watch test could not load channel ${channelId}: ${error.message}`);
    channel = null;
  }

  if (!channel?.isTextBased?.()) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'القناة مو موجودة',
          'قناة التنبيه المحفوظة ما عادت موجودة. اختر غيرها بـ `/watch channel #channel`.',
        ),
      ),
    );
    return;
  }

  try {
    await channel.send({
      allowedMentions: { parse: [] },
      embeds: [
        embed({
          title: 'تنبيهات الكلمات شغّالة',
          description: [
            'هنا بيشوف المشرف الكلمة المراقبة وقت ما تنذكر.',
            'كل تنبيه فيه الكلمة والكاتب واقتباس ورابط قفز.',
          ].join('\n'),
          color: COLORS.success,
        }),
      ],
    });

    await ctx.reply(
      ephemeral(okReply('انرسل الاختبار', `شوف ${channel} — شكل التنبيه منشور هناك.`)),
    );
  } catch (error) {
    logger.warn(`Watch test to channel ${channelId} failed: ${error.message}`);

    await ctx.fail(
      ephemeral(
        errorReply(
          'ما قدرت أنشر هناك',
          'أحتاج **عرض القنوات** و**إرسال الرسائل** و**إرفاق الروابط** في قناة التنبيه.',
        ),
      ),
    );
  }
}

function ignoredPayload(ctx) {
  const rows = listIgnoredChannels(ctx.guildId);

  if (rows.length === 0) {
    return embed({
      title: 'ما فيه قنوات متجاهَلة',
      description: [
        'الكلمات المراقبة تنبّه في كل القنوات.',
        `تجاهل قناة بـ \`${ctx.isSlash ? '/watch ignore channel:#channel' : ':-watch ignore #channel'}\`.`,
        'تجاهل تصنيف يغطي كل القنوات اللي داخله.',
      ].join('\n'),
      color: COLORS.muted,
    });
  }

  const shown = rows.slice(0, MAX_SHOWN);
  const lines = shown.map((row) => {
    const channel = ctx.guild.channels.cache.get(row.channelId);

    return channel
      ? `\u200E- <#${row.channelId}> — أضافها <@${row.createdBy}>`
      : `\u200E- ⚠️ \`${row.channelId}\` — القناة محذوفة`;
  });

  if (rows.length > shown.length) lines.push(`…و ${rows.length - shown.length} غيرها`);

  return embed({
    title: `القنوات المتجاهَلة (${rows.length})`,
    description: lines.join('\n'),
    footer: 'الكلمات المراقبة في هذي القنوات ما تنبّه أبدًا.',
    color: COLORS.primary,
  });
}

async function resolveIgnoreTarget(ctx) {
  if (ctx.isSlash) {
    return { channel: ctx.getChannel('channel'), raw: '' };
  }

  const raw = prefixChannelArg(ctx);

  if (!raw) return { channel: null, raw };

  return { channel: await resolvePrefixAnyChannel(ctx, raw).catch(() => null), raw };
}

async function handleIgnore(ctx) {
  if (!(await requireModerator(ctx))) return;

  const { channel, raw } = await resolveIgnoreTarget(ctx);

  // Slash without the option lists the current ignores, so `/watch ignore`
  // doubles as the read command.
  if (!channel) {
    if (!raw) {
      await ctx.reply(ephemeral({ embeds: [ignoredPayload(ctx)] }));
      return;
    }

    await ctx.fail(
      ephemeral(
        errorReply(
          'قناة غير معروفة',
          `ما لقيت \`${raw}\`. منشنها كـ \`#channel\` أو الصق آيدي القناة.`,
        ),
      ),
    );
    return;
  }

  if ((channel.guildId ?? channel.guild?.id) !== ctx.guildId) {
    await ctx.fail(
      ephemeral(errorReply('سيرفر غلط', 'اختر قناة من هذا السيرفر.')),
    );
    return;
  }

  if (!addIgnoredChannel(ctx.guildId, channel.id, ctx.user.id)) {
    await ctx.reply(
      ephemeral(infoReply('متجاهَلة أصلًا', `${channel} ما تنبّه على أي كلمة مراقَبة.`)),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  const isCategory = channel.type === ChannelType.GuildCategory;

  await ctx.reply(
    ephemeral(
      okReply(
        'تجاهلت القناة',
        isCategory
          ? `الكلمات المراقبة في ${channel} وكل قناة داخله ما عادت تنبّه.`
          : `الكلمات المراقبة في ${channel} ما عادت تنبّه.`,
      ),
    ),
  );
}

async function handleUnignore(ctx) {
  if (!(await requireModerator(ctx))) return;

  const { channel, raw } = await resolveIgnoreTarget(ctx);

  if (!channel) {
    await ctx.fail(
      ephemeral(
        raw
          ? errorReply(
              'قناة غير معروفة',
              `ما لقيت \`${raw}\`. منشنها كـ \`#channel\` أو الصق آيدي القناة.`,
            )
          : errorReply(
              'أي قناة؟',
              `استخدم \`${ctx.isSlash ? '/watch unignore channel:#channel' : ':-watch unignore #channel'}\`.`,
            ),
      ),
    );
    return;
  }

  if (removeIgnoredChannel(ctx.guildId, channel.id) === 0) {
    await ctx.reply(
      ephemeral(infoReply('مو متجاهَلة', `${channel} تنبّه أصلًا.`)),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral(okReply('رجعت القناة للمراقبة', `${channel} بتنبّه على الكلمات المراقبة مرة ثانية.`)),
  );
}

async function handleIgnored(ctx) {
  if (!(await requireModerator(ctx))) return;

  await ctx.reply(ephemeral({ embeds: [ignoredPayload(ctx)] }));
}

export default {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('انشر تنبيه في قناة لما تنذكر كلمة معينة')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('راقب كلمة أو عبارة')
        .addStringOption((option) =>
          option
            .setName('keyword')
            .setDescription('كلمة أو عبارة قصيرة')
            .setRequired(true)
            .setMinLength(MIN_TERM_LENGTH)
            .setMaxLength(MAX_TERM_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('وقّف مراقبة كلمة')
        .addStringOption((option) =>
          option.setName('keyword').setDescription('الكلمة اللي تبي توقفها').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('اعرض قائمة الكلمات المشتركة'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('احذف كل الكلمات'))
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('اختر وين تنكتب التنبيهات (اتركها فاضية تقفل التنبيهات)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('قناة التنبيه')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) => sub.setName('test').setDescription('انشر تنبيه تجريبي في القناة'))
    .addSubcommand((sub) =>
      sub
        .setName('ignore')
        .setDescription('لا تنبّه على الكلمات في قناة أو تصنيف')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('قناة أو تصنيف تبي تتجاهله (اتركها فاضية تعرضهم)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unignore')
        .setDescription('رجّع التنبيه على الكلمات في قناة')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('قناة أو تصنيف ترجعه للمراقبة')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('ignored').setDescription('اعرض القنوات المتجاهَلة')),

  name: 'watch',
  aliases: ['alert', 'keywords'],
  description: 'انشر تنبيه في قناة لما تنذكر كلمة معينة',
  category: 'Community',
  usage:
    'watch add <keyword> | remove <keyword> | list | clear | channel <#channel|off> | test | ignore [#channel] | unignore #channel | ignored',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['add', 'remove', 'delete', 'list', 'clear', 'test', 'channel', 'ignore', 'unignore', 'ignored'].includes(ctx.args[0])
        ? ctx.args[0]
        : 'add';

    if (sub === 'add') return handleAdd(ctx);
    if (sub === 'remove' || sub === 'delete') return handleRemove(ctx);
    if (sub === 'clear') return handleClear(ctx);
    if (sub === 'channel') return handleChannel(ctx);
    if (sub === 'test') return handleTest(ctx);
    if (sub === 'ignore') return handleIgnore(ctx);
    if (sub === 'unignore') return handleUnignore(ctx);
    if (sub === 'ignored') return handleIgnored(ctx);

    await ctx.reply(ephemeral({ embeds: [listPayload(ctx)] }));
  },
};
