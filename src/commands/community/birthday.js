import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import {
  daysInMonth,
  daysUntil,
  describeNow,
  formatListDate,
  formatMonthDay,
  isBirthdayToday,
  isValidTimeZone,
  nextOccurrence,
} from '../../lib/dates.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { ephemeral, errorReply, infoReply, okReply } from '../../lib/replies.js';
import * as store from '../../services/birthday-store.js';
import { removeBirthdayRole } from '../../services/birthday-roles.js';
import { getProfile, setBirthdayVisible } from '../../services/profile-store.js';
import {
  DEFAULT_MESSAGE,
  PLACEHOLDERS,
  announceBirthdays,
  buildGreetingPayload,
  isClearValue,
  sendGreeting,
  unknownPlaceholders,
  validateGifUrl,
  validateMessage,
} from '../../services/birthday-greetings.js';
import {
  reconcileGuild,
  syncUserBirthday,
  timezoneForBirthday,
  timezoneForGuild,
} from '../../services/birthday-scheduler.js';

const SUBCOMMAND_ALIASES = {
  add: 'set',
  save: 'set',
  delete: 'remove',
  clear: 'remove',
  upcoming: 'list',
  all: 'list',
  who: 'today',
  msg: 'message',
  greeting: 'message',
  greetings: 'message',
  chan: 'channel',
  test: 'send',
  try: 'send',
  visibility: 'show',
  privacy: 'show',
};

const MAX_FIELD_LENGTH = 1000;

function resolveSubcommand(ctx) {
  const raw = ctx.isSlash ? ctx.getSubcommand() : (ctx.args[0] ?? '').toLowerCase();
  return SUBCOMMAND_ALIASES[raw] ?? raw;
}

function isAdmin(ctx) {
  return Boolean(ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

const nameCache = new Map();

function cachedDisplayName(client, guild, userId) {
  const member = guild?.members?.cache?.get(userId);
  if (member) return member.displayName;

  const user = client?.users?.cache?.get(userId);
  if (user) return user.globalName || user.username;

  return null;
}

/**
 * Resolves a name for a member. Discord's cache is nearly empty on a fresh
 * client, so after every restart most members are unknown and the old code
 * printed a raw `<@id>` mention — which renders as a stray "@" inside
 * right-to-left names. Fetch the user over REST instead (no privileged intent
 * needed), and remember the answer for the rest of the session.
 */
async function displayName(client, guild, userId) {
  const local = cachedDisplayName(client, guild, userId);
  if (local) return local;

  const known = nameCache.get(userId);
  if (known) return known;

  try {
    const user = await client?.users?.fetch?.(userId);
    const name = user?.globalName || user?.username;

    if (name) {
      if (nameCache.size > 5000) nameCache.clear();
      nameCache.set(userId, name);
      return name;
    }
  } catch {
    // Member may have left the server; a mention is the honest fallback.
  }

  return `<@${userId}>`;
}

function chunkLines(lines, limit = MAX_FIELD_LENGTH) {
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function mentionedUser(ctx) {
  if (!ctx.message) return null;

  const mentioned = ctx.message.mentions.users.first();
  if (!mentioned) return null;

  return /^<@!?\d+>$/.test(ctx.args[1] ?? '') ? mentioned : null;
}

function userIdArg(ctx) {
  const raw = ctx.args[1];
  if (!/^\d{17,20}$/.test(raw ?? '')) return null;

  // Accept ids that are not in the cache (offline member, admin copying an id).
  return ctx.client?.users?.cache?.get(raw) ?? { id: raw, username: raw, bot: false };
}

/**
 * Resolves who a subcommand is about: `user` on slash, a mention or a raw id on
 * prefix, and yourself when nothing is given.
 */
function readTargetInput(ctx) {
  if (ctx.isSlash) return ctx.getUser('user') ?? ctx.user;

  const mention = mentionedUser(ctx);
  const byId = mention ? null : userIdArg(ctx);
  return mention ?? byId ?? ctx.user;
}

function readSetInput(ctx) {
  if (ctx.isSlash) {
    return {
      target: ctx.getUser('user') ?? ctx.user,
      month: ctx.getInteger('month'),
      day: ctx.getInteger('day'),
      year: ctx.getInteger('year') ?? null,
    };
  }

  const mention = mentionedUser(ctx);
  const byId = mention ? null : userIdArg(ctx);
  const target = mention ?? byId ?? ctx.user;
  const offset = mention || byId ? 2 : 1;

  return {
    target,
    month: Number.parseInt(ctx.args[offset] ?? '', 10),
    day: Number.parseInt(ctx.args[offset + 1] ?? '', 10),
    year: ctx.args[offset + 2] ? Number.parseInt(ctx.args[offset + 2], 10) : null,
  };
}

function validateBirthday({ month, day, year }) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return 'الشهر لازم رقم صحيح من 1 إلى 12.';
  }

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return 'اليوم لازم رقم صحيح من 1 إلى 31.';
  }

  const currentYear = new Date().getUTCFullYear();

  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > currentYear)) {
    return `السنة لازم تكون بين 1900 و${currentYear}، أو تتركها فاضية.`;
  }

  // 2000 is a leap year, so Feb 29 is accepted when no year is given.
  const referenceYear = year ?? 2000;

  if (day > daysInMonth(referenceYear, month)) {
    return `${month}/${day} مو تاريخ حقيقي.`;
  }

  return null;
}

async function handleSet(ctx) {
  const input = readSetInput(ctx);
  const target = input.target;

  if (target.id !== ctx.user.id && !isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply(
            'صلاحيات ناقصة',
            'أصحاب **إدارة السيرفر** فقط يقدرون يحددون عيد ميلاد عضو ثاني.',
          ),),
    );
    return;
  }

  if (target.bot) {
    await ctx.reply(errorReply('عضو غير صالح', 'البوتات ما عندها أعياد ميلاد.'));
    return;
  }

  const problem = validateBirthday(input);

  if (problem) {
    await ctx.reply(ephemeral(errorReply('تاريخ ميلاد غير صحيح', problem)));
    return;
  }

  store.setBirthday(ctx.guildId, target.id, input);
  await syncUserBirthday(ctx.guild, target.id);

  const saved = store.getBirthday(ctx.guildId, target.id);
  const timeZone = timezoneForBirthday(saved, store.getGuildSettings(ctx.guildId));
  const days = daysUntil(input.month, input.day, timeZone);
  const when =
    days === 0
      ? 'هذا اليوم، فالرتبة والتهنئة انطبّقت إذا كانت مضبوطة.'
      : `باقي ${days} يوم.`;
  const isSelf = target.id === ctx.user.id;
  const who = isSelf ? null : await displayName(ctx.client, ctx.guild, target.id);
  const zoneLabel = saved?.timezone ? timeZone : `${timeZone} (افتراضي السيرفر)`;

  await ctx.reply(
    ephemeral(okReply(
          isSelf ? 'انحفظ عيد الميلاد' : `انحفظ عيد ميلاد ${who}`,
          [`**${formatMonthDay(input.month, input.day)}**`, when, `المنطقة الزمنية: ${zoneLabel}`].join(
            '\n',
          ),
        ),),
  );
}

async function handleRemove(ctx) {
  const target = readTargetInput(ctx);
  const isSelf = target.id === ctx.user.id;

  if (!isSelf && !isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply(
            'صلاحيات ناقصة',
            'أصحاب **إدارة السيرفر** فقط يقدرون يحذفون عيد ميلاد عضو ثاني.',
          ),),
    );
    return;
  }

  const who = isSelf ? null : await displayName(ctx.client, ctx.guild, target.id);
  const removed = store.removeBirthday(ctx.guildId, target.id);

  if (!removed) {
    await ctx.reply(
      ephemeral(
        infoReply(
          'ما فيه شي ينحذف',
          isSelf ? 'ما سجلت عيد ميلاد بعد.' : `${who} ما عنده عيد ميلاد محفوظ.`,
        ),
      ),
    );
    return;
  }

  await syncUserBirthday(ctx.guild, target.id);

  await ctx.reply(
    ephemeral(okReply(
          isSelf ? 'انحذف عيد الميلاد' : `انحذف عيد ميلاد ${who}`,
          isSelf ? 'انحذف عيد ميلادك.' : 'انحذف عيد ميلاده المحفوظ.',
        ),),
  );
}

const SHOW_VALUES = {
  on: true,
  true: true,
  show: true,
  visible: true,
  yes: true,
  '1': true,
  off: false,
  false: false,
  hide: false,
  hidden: false,
  no: false,
  '0': false,
};

function showArgument(ctx) {
  if (ctx.isSlash) return ctx.getBoolean('visible');

  const raw = String(ctx.args[1] ?? '').trim().toLowerCase();
  return Object.hasOwn(SHOW_VALUES, raw) ? SHOW_VALUES[raw] : undefined;
}

/**
 * Per-member privacy switch for the birthday, age and time zone block on the
 * profile card. Members control their own row; staff cannot toggle it for them.
 */
async function handleShow(ctx) {
  const next = showArgument(ctx);
  const before = getProfile(ctx.guildId, ctx.user.id).showBirthday;
  const visible =
    next === undefined
      ? before
      : setBirthdayVisible(ctx.guildId, ctx.user.id, next).showBirthday;
  const hasBirthday = Boolean(store.getBirthday(ctx.guildId, ctx.user.id));
  const lines = [
    visible
      ? 'عيد ميلادك وعمرك ومنطقتك الزمنية تظهر على بطاقة ملفك.'
      : 'عيد ميلادك وعمرك ومنطقتك الزمنية مخفية من بطاقة ملفك.',
  ];

  if (!hasBirthday) {
    lines.push('ما سجلت عيد ميلاد بعد؛ هذا ينطبق أول ما تضيفه.');
  } else if (!visible) {
    lines.push('رجّعه بـ `/birthday show visible:true` وقت ما تبي.');
  }

  const title =
    next === undefined
      ? 'ظهور عيد الميلاد'
      : visible
        ? 'ظهرت خانة عيد الميلاد'
        : 'انخفت خانة عيد الميلاد';

  await ctx.reply(
    ephemeral(
      next === undefined
        ? infoReply(title, lines.join('\n'))
        : okReply(title, lines.join('\n')),
    ),
  );
}

const LIST_ORDERS = {
  nearest: { label: 'الأقرب أولًا', button: 'ترتيب التقويم', next: 'calendar' },
  calendar: { label: 'ترتيب التقويم (يناير ← ديسمبر)', button: 'الأقرب أولًا', next: 'nearest' },
};

const LIST_TIMEOUT_MS = 5 * 60 * 1000;
const LIST_DESCRIPTION_LIMIT = 3900;

function listEntries(guildId, defaultZone) {
  return store.listBirthdays(guildId).map((row) => {
    const zone = row.timezone ?? defaultZone;
    return { ...row, zone, next: nextOccurrence(row.month, row.day, zone) };
  });
}

function sortList(entries, order) {
  if (order === 'calendar') {
    return entries.sort(
      (a, b) => a.month - b.month || a.day - b.day || a.userId.localeCompare(b.userId),
    );
  }

  return entries.sort(
    (a, b) =>
      a.next.days - b.next.days ||
      a.month - b.month ||
      a.day - b.day ||
      a.userId.localeCompare(b.userId),
  );
}

function missingZoneNotice(missingZone, defaultZone) {
  if (missingZone === 0) return null;

  const fix = `صلّحها بـ \`/birthday timezone user:@member zone:<IANA>\`.`;

  return missingZone === 1
    ? `⚠️ عضو واحد ما عنده منطقة زمنية ويتبع **${defaultZone}**. ${fix}`
    : `⚠️ ${missingZone} أعضاء ما عندهم منطقة زمنية ويتبعون **${defaultZone}**. ${fix}`;
}

function listButtonRow(order) {
  const info = LIST_ORDERS[order];

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`birthday-list:${info.next}`)
      .setLabel(info.button)
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * The list as Discord shows it: one aligned line per member, date first, no
 * per-row time zone noise. `order` decides whether it is a countdown or a
 * calendar, and both render from the same rows.
 *
 * Rows use mentions rather than resolved names: Discord draws the current
 * display name and role colour itself, it survives renames without a re-render,
 * and it costs no REST calls. `parse: []` on the payload means nobody is pinged.
 */
function buildListPayload(ctx, order) {
  const defaultZone = timezoneForGuild(ctx.guildId);
  const entries = sortList(listEntries(ctx.guildId, defaultZone), order);

  const lines = entries.map((entry) => {
    // The calendar view spans years anyway, so the year would only be noise.
    const date =
      order === 'calendar'
        ? formatListDate(null, entry.month, entry.day)
        : formatListDate(entry.next.year, entry.month, entry.day);
    const cake = entry.next.days === 0 ? ' 🎂' : '';
    const flag = entry.timezone ? '' : ' ⚠️';

    return `\`${date}\` · <@${entry.userId}>${cake}${flag}`;
  });

  const missingZone = entries.filter((entry) => !entry.timezone).length;
  const notice = missingZoneNotice(missingZone, defaultZone);
  const chunks = chunkLines(lines, LIST_DESCRIPTION_LIMIT);

  const embeds = chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;

    return embed({
      title: index === 0 ? '🎂 قائمة أعياد الميلاد' : undefined,
      description: isLast && notice ? `${chunk}\n\n${notice}` : chunk,
      footer:
        index === 0
          ? `${entries.length} عضو · ${LIST_ORDERS[order].label} · افتراضي السيرفر ${defaultZone}`
          : undefined,
      timestamp: index === 0,
    });
  });

  return { embeds, components: [listButtonRow(order)] };
}

function attachListCollector({ ctx, message, state }) {
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: LIST_TIMEOUT_MS,
  });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== ctx.user.id) {
      await interaction
        .reply(
          ephemeral({
            embeds: [
              errorReply(
                'هذي القائمة مو لك',
                'شغّل `/birthday list` بنفسك عشان تبدّل الترتيب.',
              ),
            ],
          }),
        )
        .catch(() => {});
      return;
    }

    state.order = interaction.customId.endsWith(':calendar') ? 'calendar' : 'nearest';

    const payload = buildListPayload(ctx, state.order);
    await interaction.update({ ...payload, allowedMentions: { parse: [] } }).catch(() => {});
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}

async function handleList(ctx) {
  if (store.listBirthdays(ctx.guildId).length === 0) {
    await ctx.reply(
      infoReply(
        'ما فيه أعياد ميلاد بعد',
        `ما سجّل أحد عيد ميلاده. استخدم \`/birthday set\` أو \`${config.prefix}birthday set <month> <day>\`.`,
      ),
    );
    return;
  }

  const state = { order: 'nearest' };
  const payload = buildListPayload(ctx, state.order);
  const sent = await ctx.reply({ ...payload, allowedMentions: { parse: [] } });

  let message = ctx.isSlash ? null : sent;
  if (ctx.isSlash && ctx.interaction?.fetchReply) {
    message = await ctx.interaction.fetchReply().catch(() => null);
  }

  attachListCollector({ ctx, message, state });
}

async function handleToday(ctx) {
  const defaultZone = timezoneForGuild(ctx.guildId);
  const rows = store
    .listBirthdays(ctx.guildId)
    .filter((row) => isBirthdayToday(row.month, row.day, row.timezone ?? defaultZone));

  if (rows.length === 0) {
    await ctx.reply({
      embeds: [
        embed({
          title: 'ما فيه أعياد ميلاد اليوم',
          description: 'ما فيه أحد يحتفل اليوم في منطقته الزمنية.',
          color: COLORS.muted,
        }),
      ],
    });
    return;
  }

  const settings = store.getGuildSettings(ctx.guildId);
  const lines = rows.map((row) => {
    const zoneNote =
      row.timezone && row.timezone !== defaultZone ? ` (${row.timezone})` : '';

    return `• <@${row.userId}>${zoneNote}`;
  });
  const fields = [];

  if (settings.birthdayRoleId) {
    fields.push({
      name: 'رتبة عيد الميلاد',
      value: `<@&${settings.birthdayRoleId}> مفعّلة اليوم.`,
      inline: true,
    });
  }

  if (settings.birthdayChannelId) {
    fields.push({
      name: 'التهاني',
      value: `تنكتب في <#${settings.birthdayChannelId}>.`,
      inline: true,
    });
  }

  await ctx.reply({
    allowedMentions: { parse: [] },
    embeds: [
      embed({
        title: 'أعياد ميلاد اليوم',
        description: lines.join('\n'),
        fields,
      }),
    ],
  });
}

async function handleNext(ctx) {
  const target = ctx.isSlash
    ? (ctx.getUser('user') ?? ctx.user)
    : (ctx.message.mentions.users.first() ?? ctx.user);

  const row = store.getBirthday(ctx.guildId, target.id);

  if (!row) {
    const who = target.id === ctx.user.id ? 'ما سجلت' : `${target.username} ما سجل`;
    await ctx.reply({
      embeds: [
        errorReply('ما فيه عيد ميلاد محفوظ', `${who} عيد ميلاد في هذا السيرفر.`),
      ],
    });
    return;
  }

  const timeZone = row.timezone ?? timezoneForGuild(ctx.guildId);
  const occurrence = nextOccurrence(row.month, row.day, timeZone);
  const title =
    target.id === ctx.user.id ? 'عيد ميلادك' : `عيد ميلاد ${target.username}`;
  const isToday = occurrence.days === 0;

  // A Discord timestamp renders as "in 5 months" and shows the exact date on
  // hover/tap, and it stays correct without the message being re-sent.
  const countdown = isToday
    ? '🎉 **اليوم** — كل عام وأنت بخير!'
    : `<t:${occurrence.unix}:R>`;

  await ctx.reply({
    embeds: [
      embed({
        title,
        description: [`**${occurrence.formatted}** · ${occurrence.weekday}`, countdown].join('\n'),
        fields: [
          { name: 'التاريخ الكامل', value: `<t:${occurrence.unix}:F>`, inline: false },
          { name: 'المنطقة الزمنية', value: timeZone, inline: false },
        ],
      }),
    ],
  });
}

async function handleRole(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج صلاحية إدارة السيرفر.')),
    );
    return;
  }

  const guild = ctx.guild;
  const role = ctx.isSlash ? ctx.getRole('role') : (ctx.message.mentions.roles.first() ?? null);
  const settings = store.getGuildSettings(guild.id);

  if (!role) {
    if (!settings.birthdayRoleId) {
      await ctx.reply(
        infoReply('ما فيه رتبة عيد ميلاد', 'ما فيه رتبة عيد ميلاد مضبوطة الحين.'),
      );
      return;
    }

    for (const assignment of store.listAssignments(guild.id)) {
      if (assignment.roleId === settings.birthdayRoleId) {
        await removeBirthdayRole(guild, assignment.userId, assignment.roleId);
      }
    }

    store.deleteAssignmentsForRole(guild.id, settings.birthdayRoleId);
    store.setGuildRole(guild.id, null);

    await ctx.reply(
      okReply('انمسحت رتبة عيد الميلاد', 'انشالت رتبة عيد الميلاد من الكل.'),
    );
    return;
  }

  if (role.id === guild.id) {
    await ctx.reply(errorReply('رتبة غير صالحة', '@everyone ما تنفع رتبة عيد ميلاد.'));
    return;
  }

  if (role.managed) {
    await ctx.reply(
      errorReply('رتبة غير صالحة', 'هذي الرتبة مرتبطة بتكامل وما تنعطى يدويًا.'),
    );
    return;
  }

  const me = guild.members.me;

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await ctx.reply(errorReply('صلاحيات ناقصة', 'أحتاج صلاحية **إدارة الرتب**.'));
    return;
  }

  if (me.roles.highest.position <= role.position) {
    await ctx.reply(
      errorReply(
        'مشكلة في ترتيب الرتب',
        `أعلى رتبة عندي (${me.roles.highest}) لازم تكون فوق ${role} في قائمة الرتب. ارفع رتبتي من إعدادات السيرفر ← الرتب.`,
      ),
    );
    return;
  }

  if (settings.birthdayRoleId && settings.birthdayRoleId !== role.id) {
    for (const assignment of store.listAssignments(guild.id)) {
      if (assignment.roleId === settings.birthdayRoleId) {
        await removeBirthdayRole(guild, assignment.userId, assignment.roleId);
        store.deleteAssignment(guild.id, assignment.userId);
      }
    }
  }

  store.setGuildRole(guild.id, role.id);
  await reconcileGuild(guild);

  await ctx.reply(okReply(
        'انضبطت رتبة عيد الميلاد',
        `${role} تنعطى في عيد ميلاد العضو وتنشال اليوم اللي بعده.`,
      ),);
}

function parseTimezoneInput(ctx) {
  if (ctx.isSlash) {
    return {
      target: ctx.getUser('user') ?? ctx.user,
      zone: ctx.getString('zone')?.trim() || null,
      useDefault: ctx.getBoolean('default') ?? false,
    };
  }

  const args = ctx.args.slice(1);
  let useDefault = false;
  let target = ctx.user;
  let index = 0;

  if (args[0]?.toLowerCase() === '--default' || args[0]?.toLowerCase() === 'default') {
    useDefault = true;
    index = 1;
  } else {
    const mention = ctx.message.mentions.users.first();

    if (mention && /^<@!?\d+>$/.test(args[0] ?? '')) {
      target = mention;
      index = 1;
    } else if (/^\d{17,20}$/.test(args[0] ?? '')) {
      const user = ctx.client?.users?.cache?.get(args[0]);
      if (user) {
        target = user;
        index = 1;
      }
    }
  }

  const raw = args.slice(index).join(' ').trim();

  return {
    target,
    zone: raw && !isClearValue(raw) ? raw : null,
    useDefault,
  };
}

async function handleTimezone(ctx) {
  const input = parseTimezoneInput(ctx);
  const guild = ctx.guild;

  if (input.useDefault) {
    if (!isAdmin(ctx)) {
      await ctx.reply(
        ephemeral(errorReply(
              'صلاحيات ناقصة',
              'أصحاب **إدارة السيرفر** فقط يقدرون يغيّرون افتراضي السيرفر.',
            ),),
      );
      return;
    }

    if (!input.zone) {
      store.setGuildTimezone(guild.id, null);
      await reconcileGuild(guild);

      await ctx.reply(okReply(
            'انصفّر افتراضي السيرفر',
            `الأعضاء اللي ما عندهم منطقة زمنية صاروا يستخدمون **${config.timezone}**.`,
          ),);
      return;
    }

    if (!isValidTimeZone(input.zone)) {
      await ctx.reply(errorReply(
            'منطقة زمنية غير صحيحة',
            `"${input.zone}" مو منطقة IANA صحيحة. جرّب شي مثل \`Europe/Berlin\` أو \`America/New_York\`.`,
          ),);
      return;
    }

    store.setGuildTimezone(guild.id, input.zone);
    await reconcileGuild(guild);

    await ctx.reply(okReply(
          'تحدّث افتراضي السيرفر',
          `الأعضاء اللي ما عندهم منطقة زمنية صاروا يستخدمون **${input.zone}**.\nالوقت هناك الحين: ${describeNow(input.zone)}.`,
        ),);
    return;
  }

  const target = input.target;
  const isSelf = target.id === ctx.user.id;
  const who = await displayName(ctx.client, guild, target.id);

  if (!isSelf && !isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply(
            'صلاحيات ناقصة',
            'أصحاب **إدارة السيرفر** فقط يقدرون يغيّرون منطقة عضو ثاني الزمنية.',
          ),),
    );
    return;
  }

  if (target.bot) {
    await ctx.reply(errorReply('عضو غير صالح', 'البوتات ما عندها أعياد ميلاد.'));
    return;
  }

  const birthday = store.getBirthday(guild.id, target.id);

  if (!birthday) {
    const subject = isSelf ? 'ما سجلت' : `${who} ما سجل`;
    await ctx.reply(errorReply(
          'ما فيه عيد ميلاد محفوظ',
          `${subject} عيد ميلاد بعد. حدده بـ \`/birthday set\` أول.`,
        ),);
    return;
  }

  if (!input.zone) {
    store.setBirthdayTimezone(guild.id, target.id, null);
    await reconcileGuild(guild);

    const fallback = timezoneForGuild(guild.id);

    await ctx.reply(okReply(
          isSelf ? 'انصفّرت المنطقة الزمنية' : `انصفّرت المنطقة الزمنية لـ ${who}`,
          `الحين يستخدم افتراضي السيرفر: **${fallback}**.`,
        ),);
    return;
  }

  if (!isValidTimeZone(input.zone)) {
    await ctx.reply(errorReply(
          'Invalid time zone',
          `"${input.zone}" is not a valid IANA time zone. Try something like \`Europe/Berlin\` or \`America/New_York\`.`,
        ),);
    return;
  }

  store.setBirthdayTimezone(guild.id, target.id, input.zone);
  await reconcileGuild(guild);

  await ctx.reply(okReply(
        isSelf ? 'تحدّثت المنطقة الزمنية' : `تحدّثت المنطقة الزمنية لـ ${who}`,
        [
          `أعياد الميلاد تتبدّل منتصف الليل بـ **${input.zone}**.`,
          `الوقت هناك الحين: ${describeNow(input.zone)}.`,
        ].join('\n'),
      ),);
}

async function resolveChannelArg(ctx) {
  const mentioned = ctx.message.mentions.channels.first();
  if (mentioned) return mentioned;

  const raw = ctx.args[1];
  if (!raw) return null;

  const id = raw.replace(/[<#>]/g, '');
  if (!/^\d+$/.test(id)) return null;

  return (
    ctx.guild.channels.cache.get(id) ??
    (await ctx.guild.channels.fetch(id).catch(() => null))
  );
}

async function handleChannel(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج صلاحية إدارة السيرفر.')),
    );
    return;
  }

  const guild = ctx.guild;
  const settings = store.getGuildSettings(guild.id);

  const wantsClear = ctx.isSlash
    ? !ctx.getChannel('channel')
    : !ctx.args[1] || isClearValue(ctx.args[1]);

  if (wantsClear) {
    if (!settings.birthdayChannelId) {
      await ctx.reply(
        infoReply('ما فيه قناة عيد ميلاد', 'ما فيه قناة تهنئة مضبوطة الحين.'),
      );
      return;
    }

    store.setGuildChannel(guild.id, null);

    await ctx.reply(
      okReply('انمسحت قناة عيد الميلاد', 'ما عاد تنكتب تهنئة.'),
    );
    return;
  }

  const channel = ctx.isSlash ? ctx.getChannel('channel') : await resolveChannelArg(ctx);

  if (!channel) {
    await ctx.reply(
      ephemeral(errorReply(
            'القناة غير موجودة',
            `منشن قناة نصية، مثل \`${config.prefix}birthday channel #general\`.`,
          ),),
    );
    return;
  }

  if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
    await ctx.reply(errorReply('قناة غير صالحة', 'اختر قناة نصية أو إعلانات.'));
    return;
  }

  const me = guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;

  if (
    permissions &&
    (!permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks))
  ) {
    await ctx.reply(errorReply(
          'صلاحيات القناة ناقصة',
          `ما أقدر أنشر في ${channel}. أعطني **عرض القنوات** و**إرسال الرسائل** و**إرفاق الروابط** هناك.`,
        ),);
    return;
  }

  store.setGuildChannel(guild.id, channel.id);

  const updated = store.getGuildSettings(guild.id);
  const result = await announceBirthdays(guild, updated);
  const fields = [];

  if (result.sent > 0) {
    fields.push({
      name: 'اليوم',
      value: `انرسلت ${result.sent} تهنئة لأعياد ميلاد اليوم.`,
    });
  }

  if (result.error) {
    fields.push({
      name: 'ملاحظة',
      value: 'انحفظ، لكن تهنئة اليوم ما انكتبت. تأكد من صلاحياتي في القناة.',
    });
  }

  await ctx.reply({
    embeds: [
      embed({
        title: 'انضبطت قناة عيد الميلاد',
        description: [
          `التهاني بتنكتب في ${channel}.`,
          `المنطقة الزمنية: **${updated.timezone ?? config.timezone}**.`,
          `خصّص النص والـ GIF بـ \`/birthday message\`.`,
        ].join('\n'),
        color: COLORS.success,
        fields,
      }),
    ],
  });
}

function parseMessageInput(ctx) {
  if (ctx.isSlash) {
    return {
      text: ctx.getString('text')?.trim() || undefined,
      gif: ctx.getString('gif')?.trim() || undefined,
      reset: ctx.getBoolean('reset') ?? false,
    };
  }

  const rest = ctx.args.slice(1).join(' ').trim();
  if (!rest) return {};
  if (rest.toLowerCase() === 'reset') return { reset: true };
  if (rest.toLowerCase() === 'show') return {};

  const separator = rest.lastIndexOf('|');

  if (separator !== -1) {
    const text = rest.slice(0, separator).trim();
    const gif = rest.slice(separator + 1).trim();
    return { text: text || undefined, gif: gif || 'none' };
  }

  return { text: rest };
}

function messageConfigEmbed(ctx, { template, gifUrl, timeZone, title, footer, warning }) {
  const birthday = store.getBirthday(ctx.guildId, ctx.user.id);
  const payload = buildGreetingPayload({
    guildName: ctx.guild.name,
    userId: ctx.user.id,
    name: ctx.member?.displayName ?? ctx.user.username,
    birthday,
    template,
    gifUrl,
    timeZone,
  });

  const builder = payload.embeds[0];

  if (title) builder.setTitle(title);
  if (!builder.data.description) {
    builder.setDescription('_ما بقي شي بعد ما تنعبّى المتغيرات._');
  }

  const rawTemplate =
    template.length > 1000 ? `${template.slice(0, 999)}\u2026` : template;

  builder.addFields(
    { name: 'القالب', value: rawTemplate },
    {
      name: 'المتغيرات',
      value: PLACEHOLDERS.map(
        (placeholder) => `\`{${placeholder.key}}\` ${placeholder.description}`,
      ).join('\n'),
    },
  );

  if (warning) builder.addFields({ name: 'تحذير', value: warning });

  builder.setFooter({
    text: footer ?? `المعاينة تستخدم ملفك · المنطقة الزمنية: ${timeZone}`,
  });

  return builder;
}

async function handleMessage(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج صلاحية إدارة السيرفر.')),
    );
    return;
  }

  const guild = ctx.guild;
  const settings = store.getGuildSettings(guild.id);
  const timeZone = settings.timezone ?? config.timezone;
  const currentTemplate = settings.birthdayMessage ?? DEFAULT_MESSAGE;
  const currentGif = settings.birthdayGifUrl ?? null;
  const input = parseMessageInput(ctx);
  const showing =
    !input.reset && input.text === undefined && input.gif === undefined;

  if (showing) {
    await ctx.reply(
      ephemeral({
        embeds: [
          messageConfigEmbed(ctx, {
            template: currentTemplate,
            gifUrl: currentGif,
            timeZone,
            title: 'رسالة عيد الميلاد',
            footer: `غيّرها بـ ${config.prefix}birthday message <text> | <gif> · المنطقة الزمنية: ${timeZone}`,
          }),
        ],
      }),
    );
    return;
  }

  if (input.reset) {
    store.setGuildMessage(guild.id, null);
    store.setGuildGif(guild.id, null);

    await ctx.reply(
      ephemeral({
        embeds: [
          messageConfigEmbed(ctx, {
            template: DEFAULT_MESSAGE,
            gifUrl: null,
            timeZone,
            title: 'انصفّرت رسالة عيد الميلاد',
            footer: `رجع النص الافتراضي وانشال الـ GIF · المنطقة الزمنية: ${timeZone}`,
          }),
        ],
      }),
    );
    return;
  }

  let nextTemplate = currentTemplate;
  let nextGif = currentGif;
  const problems = [];

  if (input.text !== undefined) {
    const problem = validateMessage(input.text);
    if (problem) problems.push(problem);
    else nextTemplate = input.text.trim();
  }

  if (input.gif !== undefined) {
    if (isClearValue(input.gif)) {
      nextGif = null;
    } else {
      const problem = validateGifUrl(input.gif);
      if (problem) problems.push(problem);
      else nextGif = input.gif.trim();
    }
  }

  if (problems.length > 0) {
    await ctx.reply(ephemeral(errorReply('رسالة غير صحيحة', problems.join('\n'))));
    return;
  }

  if (input.text !== undefined) {
    store.setGuildMessage(guild.id, nextTemplate === DEFAULT_MESSAGE ? null : nextTemplate);
  }

  if (input.gif !== undefined) {
    store.setGuildGif(guild.id, nextGif);
  }

  const unknown = unknownPlaceholders(nextTemplate);
  const warning =
    unknown.length > 0
      ? `المتغيرات غير المعروفة بتطلع كما هي: ${unknown
          .map((key) => `\`{${key}}\``)
          .join(', ')}`
      : undefined;

  await ctx.reply(
    ephemeral({
      embeds: [
        messageConfigEmbed(ctx, {
          template: nextTemplate,
          gifUrl: nextGif,
          timeZone,
          title: 'تحدّثت رسالة عيد الميلاد',
          footer: `تنطبق من التهنئة الجاية · المنطقة الزمنية: ${timeZone}`,
          warning,
        }),
      ],
    }),
  );
}

async function handleSend(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج صلاحية إدارة السيرفر.')),
    );
    return;
  }

  const guild = ctx.guild;
  const settings = store.getGuildSettings(guild.id);

  if (!settings.birthdayChannelId) {
    await ctx.reply(
      ephemeral(errorReply(
            'ما فيه قناة عيد ميلاد',
            'اضبطها أول بـ `/birthday channel #channel`، وبعدها جرّب.',
          ),),
    );
    return;
  }

  const target = ctx.isSlash
    ? (ctx.getUser('user') ?? ctx.user)
    : (ctx.message.mentions.users.first() ?? ctx.user);

  const result = await sendGreeting(guild, settings, target.id);

  if (!result.ok) {
    const reasons = {
      'channel-missing': 'القناة المضبوطة ما عادت موجودة. اضبطها مرة ثانية بـ `/birthday channel`.',
      'missing-permissions': 'أحتاج **إرسال الرسائل** و**إرفاق الروابط** في هذي القناة.',
      'member-missing': 'هذا العضو مو في السيرفر.',
      'send-failed': 'ديسكورد رفض الرسالة. تأكد من صلاحياتي في القناة.',
      'no-channel': 'ما فيه قناة عيد ميلاد مضبوطة.',
    };

    await ctx.reply(
      ephemeral(errorReply(
            'ما قدرت أرسل التهنئة',
            reasons[result.error] ?? 'صار خطأ وأنا أنشر التهنئة.',
          ),),
    );
    return;
  }

  const ping = result.pingSuppressed
    ? '⚠️ ما عندي **منشن الجميع** في هذي القناة، فما انرسل منشن.'
    : 'انرسل منشن للجميع.';

  await ctx.reply(
    ephemeral(okReply(
          'انرسلت التهنئة',
          `انكتب القالب الحالي في ${result.channel} لـ ${target}. ${ping}`,
        ),),
  );
}

function overviewEmbed(ctx) {
  const settings = store.getGuildSettings(ctx.guildId);
  const timeZone = settings.timezone ?? config.timezone;

  return embed({
    title: 'أوامر عيد الميلاد',
    description: [
      '`/birthday set <month> <day> [year] [user]` — احفظ عيد ميلاد (المشرفون: لغيرهم)',
      '`/birthday remove [user]` — احذف عيد ميلاد (المشرفون: لغيرهم)',
      '`/birthday show [visible]` — اظهر أو اخفِ خانة عيد الميلاد على بطاقتك',
      '`/birthday list` — الكل، الأقرب أولًا أو من يناير إلى ديسمبر',
      '`/birthday today` — مين عيد ميلاده اليوم',
      '`/birthday next [user]` — العدّ التنازلي لك أو لغيرك',
      '`/birthday role [role]` — مشرف: اختر رتبة عيد الميلاد',
      '`/birthday channel [#channel]` — مشرف: وين تنكتب التهاني',
      '`/birthday message [text] [gif]` — مشرف: نص التهنئة والمتغيرات والـ GIF',
      '`/birthday send [user]` — مشرف: انشر التهنئة الحين (منشن @everyone)',
      '`/birthday timezone [zone] [user]` — منطقة العضو الزمنية (المشرفون: لغيرهم)',
      '`/birthday timezone default:true [zone]` — مشرف: افتراضي السيرفر',
      '',
      `البادئة تشتغل بعد: \`${config.prefix}birthday set 5 14\`.`,
    ].join('\n'),
    fields: [
      {
        name: 'رتبة عيد الميلاد',
        value: settings.birthdayRoleId ? `<@&${settings.birthdayRoleId}>` : 'ما انضبطت',
        inline: true,
      },
      {
        name: 'قناة التهاني',
        value: settings.birthdayChannelId ? `<#${settings.birthdayChannelId}>` : 'ما انضبطت',
        inline: true,
      },
      { name: 'المنطقة الزمنية الافتراضية', value: timeZone, inline: true },
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('سجل أعياد الميلاد والعدّ التنازلي والرتبة والتهاني')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('احفظ أو حدّث عيد ميلاد')
        .addIntegerOption((option) =>
          option
            .setName('month')
            .setDescription('الشهر (1-12)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(12),
        )
        .addIntegerOption((option) =>
          option
            .setName('day')
            .setDescription('اليوم (1-31)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31),
        )
        .addIntegerOption((option) =>
          option
            .setName('year')
            .setDescription('سنة الميلاد (اختياري)')
            .setRequired(false)
            .setMinValue(1900)
            .setMaxValue(new Date().getUTCFullYear()),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('مشرف: حدّد عيد ميلاد عضو ثاني (إدارة السيرفر)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('احذف عيد ميلاد محفوظ (المشرفون يقدرون لعضو ثاني)')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('مشرف: احذف عيد ميلاد عضو ثاني (إدارة السيرفر)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('show')
        .setDescription('اظهر أو اخفِ عيد ميلادك وعمرك ومنطقتك الزمنية على بطاقتك')
        .addBooleanOption((option) =>
          option
            .setName('visible')
            .setDescription('أظهر الخانة على بطاقتك (اتركها فاضية تشوف الإعداد الحالي)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('اعرض كل أعياد الميلاد (الأقرب أولًا أو ترتيب التقويم)'),
    )
    .addSubcommand((sub) => sub.setName('today').setDescription('اعرض مين عيد ميلاده اليوم'))
    .addSubcommand((sub) =>
      sub
        .setName('next')
        .setDescription('العدّ التنازلي لعيد ميلادك أو عيد ميلاد غيرك')
        .addUserOption((option) =>
          option.setName('user').setDescription('عيد ميلاد مين تبي تشوف').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('role')
        .setDescription('مشرف: اضبط رتبة عيد الميلاد (اتركها فاضية تمسحها)')
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تنعطى').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('مشرف: قناة تهاني عيد الميلاد (اتركها فاضية تمسحها)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('وين تنكتب التهاني')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('message')
        .setDescription('مشرف: خصّص نص التهنئة والـ GIF')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('النص مع المتغيرات: {user} {name} {age} {server} {date}')
            .setRequired(false)
            .setMaxLength(2000),
        )
        .addStringOption((option) =>
          option
            .setName('gif')
            .setDescription('رابط GIF أو صورة مباشر، أو "none" لإزالته')
            .setRequired(false)
            .setMaxLength(1000),
        )
        .addBooleanOption((option) =>
          option
            .setName('reset')
            .setDescription('ارجع النص الافتراضي واشل الـ GIF')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('send')
        .setDescription('مشرف: انشر التهنئة في القناة المضبوطة الحين')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('منو تهنّي (الافتراضي: أنت)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('timezone')
        .setDescription('حدّد منطقة عضو الزمنية (اتركها فاضية للافتراضي)')
        .addStringOption((option) =>
          option
            .setName('zone')
            .setDescription('منطقة IANA الزمنية، مثل Europe/Berlin')
            .setRequired(false)
            .setAutocomplete(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('مشرف: غيّر منطقة عضو ثاني الزمنية')
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName('default')
            .setDescription('مشرف: غيّر افتراضي السيرفر بدال عضو')
            .setRequired(false),
        ),
    ),

  name: 'birthday',
  aliases: ['bd', 'bday', 'birthdays'],
  description: 'سجل أعياد الميلاد والعدّ التنازلي والرتبة والتهاني',
  category: 'Community',
  usage: 'birthday <set|remove|list|today|next|role|channel|message|send|timezone>',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name !== 'zone') {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? '').toLowerCase();
    const zones = Intl.supportedValuesOf('timeZone')
      .filter((zone) => zone.toLowerCase().includes(query))
      .slice(0, 25)
      .map((zone) => ({ name: zone, value: zone }));

    await interaction.respond(zones);
  },

  async execute(ctx, client) {
    const subcommand = resolveSubcommand(ctx);

    switch (subcommand) {
      case 'set':
        return handleSet(ctx);
      case 'remove':
        return handleRemove(ctx);
      case 'show':
        return handleShow(ctx);
      case 'list':
        return handleList(ctx, client);
      case 'today':
        return handleToday(ctx, client);
      case 'next':
        return handleNext(ctx);
      case 'role':
        return handleRole(ctx);
      case 'channel':
        return handleChannel(ctx);
      case 'message':
        return handleMessage(ctx);
      case 'send':
        return handleSend(ctx);
      case 'timezone':
        return handleTimezone(ctx);
      default:
        return ctx.reply({ embeds: [overviewEmbed(ctx)] });
    }
  },
};
