import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
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
import { COLORS, embed, errorEmbed, successEmbed } from '../../lib/embeds.js';
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

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

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
    return 'Month must be a whole number from 1 to 12.';
  }

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return 'Day must be a whole number from 1 to 31.';
  }

  const currentYear = new Date().getUTCFullYear();

  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > currentYear)) {
    return `Year must be between 1900 and ${currentYear}, or left out.`;
  }

  // 2000 is a leap year, so Feb 29 is accepted when no year is given.
  const referenceYear = year ?? 2000;

  if (day > daysInMonth(referenceYear, month)) {
    return `${month}/${day} is not a real date.`;
  }

  return null;
}

async function handleSet(ctx) {
  const input = readSetInput(ctx);
  const target = input.target;

  if (target.id !== ctx.user.id && !isAdmin(ctx)) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Missing permissions',
            "Only members with **Manage Server** can set someone else's birthday.",
          ),
        ],
      }),
    );
    return;
  }

  if (target.bot) {
    await ctx.reply({
      embeds: [errorEmbed('Invalid member', 'Bots do not have birthdays.')],
    });
    return;
  }

  const problem = validateBirthday(input);

  if (problem) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid birthday', problem)] }));
    return;
  }

  store.setBirthday(ctx.guildId, target.id, input);
  await syncUserBirthday(ctx.guild, target.id);

  const saved = store.getBirthday(ctx.guildId, target.id);
  const timeZone = timezoneForBirthday(saved, store.getGuildSettings(ctx.guildId));
  const days = daysUntil(input.month, input.day, timeZone);
  const when =
    days === 0
      ? 'That is today, so the role and greeting were applied if configured.'
      : `That is ${days} day${days === 1 ? '' : 's'} away.`;
  const isSelf = target.id === ctx.user.id;
  const who = isSelf ? null : await displayName(ctx.client, ctx.guild, target.id);
  const zoneLabel = saved?.timezone ? timeZone : `${timeZone} (server default)`;

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          isSelf ? 'Birthday saved' : `Birthday saved for ${who}`,
          [`**${formatMonthDay(input.month, input.day)}**`, when, `Time zone: ${zoneLabel}`].join(
            '\n',
          ),
        ),
      ],
    }),
  );
}

async function handleRemove(ctx) {
  const target = readTargetInput(ctx);
  const isSelf = target.id === ctx.user.id;

  if (!isSelf && !isAdmin(ctx)) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Missing permissions',
            "Only members with **Manage Server** can remove someone else's birthday.",
          ),
        ],
      }),
    );
    return;
  }

  const who = isSelf ? null : await displayName(ctx.client, ctx.guild, target.id);
  const removed = store.removeBirthday(ctx.guildId, target.id);

  if (!removed) {
    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: 'Nothing to remove',
            description: isSelf
              ? 'You have not registered a birthday yet.'
              : `${who} has no birthday saved.`,
            color: COLORS.muted,
          }),
        ],
      }),
    );
    return;
  }

  await syncUserBirthday(ctx.guild, target.id);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          isSelf ? 'Birthday removed' : `Birthday removed for ${who}`,
          isSelf ? 'Your birthday was deleted.' : 'Their saved birthday was deleted.',
        ),
      ],
    }),
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
      ? 'Your birthday, age and time zone are shown on your profile card.'
      : 'Your birthday, age and time zone are hidden from your profile card.',
  ];

  if (!hasBirthday) {
    lines.push('You have not registered a birthday yet; this applies when you add one.');
  } else if (!visible) {
    lines.push('Set it with `/birthday show visible:true` whenever you want it back.');
  }

  const title =
    next === undefined
      ? 'Birthday visibility'
      : visible
        ? 'Birthday block shown'
        : 'Birthday block hidden';

  await ctx.reply(
    ephemeral({
      embeds: [
        next === undefined
          ? embed({ title, description: lines.join('\n'), color: COLORS.muted })
          : successEmbed(title, lines.join('\n')),
      ],
    }),
  );
}

const LIST_ORDERS = {
  nearest: { label: 'Nearest first', button: 'Calendar order', next: 'calendar' },
  calendar: { label: 'Calendar order (Jan → Dec)', button: 'Nearest first', next: 'nearest' },
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

  const fix = `Fix with \`/birthday timezone user:@member zone:<IANA>\`.`;

  return missingZone === 1
    ? `⚠️ 1 member has no time zone and follows **${defaultZone}**. ${fix}`
    : `⚠️ ${missingZone} members have no time zone and follow **${defaultZone}**. ${fix}`;
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
      title: index === 0 ? '🎂 Birthday List' : undefined,
      description: isLast && notice ? `${chunk}\n\n${notice}` : chunk,
      footer:
        index === 0
          ? `${entries.length} member${entries.length === 1 ? '' : 's'} · ${LIST_ORDERS[order].label} · server default ${defaultZone}`
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
              errorEmbed(
                'That list is not yours',
                'Run `/birthday list` yourself to switch the order.',
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
    await ctx.reply({
      embeds: [
        embed({
          title: 'No birthdays yet',
          description: `Nobody has registered a birthday. Use \`/birthday set\` or \`${config.prefix}birthday set <month> <day>\`.`,
          color: COLORS.muted,
        }),
      ],
    });
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
          title: 'No birthdays today',
          description: 'Nobody is celebrating today in their own time zone.',
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
      name: 'Birthday role',
      value: `<@&${settings.birthdayRoleId}> is active today.`,
      inline: true,
    });
  }

  if (settings.birthdayChannelId) {
    fields.push({
      name: 'Greetings',
      value: `Posted in <#${settings.birthdayChannelId}>.`,
      inline: true,
    });
  }

  await ctx.reply({
    allowedMentions: { parse: [] },
    embeds: [
      embed({
        title: 'Birthdays today',
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
    const who = target.id === ctx.user.id ? 'You have' : `${target.username} has`;
    await ctx.reply({
      embeds: [
        errorEmbed('No birthday saved', `${who} not registered a birthday in this server.`),
      ],
    });
    return;
  }

  const timeZone = row.timezone ?? timezoneForGuild(ctx.guildId);
  const occurrence = nextOccurrence(row.month, row.day, timeZone);
  const title =
    target.id === ctx.user.id ? 'Your birthday' : `${target.username}'s birthday`;
  const isToday = occurrence.days === 0;

  // A Discord timestamp renders as "in 5 months" and shows the exact date on
  // hover/tap, and it stays correct without the message being re-sent.
  const countdown = isToday
    ? '🎉 **Today** — happy birthday!'
    : `<t:${occurrence.unix}:R>`;

  await ctx.reply({
    embeds: [
      embed({
        title,
        description: [`**${occurrence.formatted}** · ${occurrence.weekday}`, countdown].join('\n'),
        fields: [
          { name: 'Full date', value: `<t:${occurrence.unix}:F>`, inline: false },
          { name: 'Time zone', value: timeZone, inline: false },
        ],
      }),
    ],
  });
}

async function handleRole(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Missing permissions', 'You need the Manage Server permission.')],
      }),
    );
    return;
  }

  const guild = ctx.guild;
  const role = ctx.isSlash ? ctx.getRole('role') : (ctx.message.mentions.roles.first() ?? null);
  const settings = store.getGuildSettings(guild.id);

  if (!role) {
    if (!settings.birthdayRoleId) {
      await ctx.reply({
        embeds: [
          embed({
            title: 'No birthday role',
            description: 'No birthday role is configured right now.',
            color: COLORS.muted,
          }),
        ],
      });
      return;
    }

    for (const assignment of store.listAssignments(guild.id)) {
      if (assignment.roleId === settings.birthdayRoleId) {
        await removeBirthdayRole(guild, assignment.userId, assignment.roleId);
      }
    }

    store.deleteAssignmentsForRole(guild.id, settings.birthdayRoleId);
    store.setGuildRole(guild.id, null);

    await ctx.reply({
      embeds: [
        successEmbed('Birthday role cleared', 'The birthday role was removed from everyone.'),
      ],
    });
    return;
  }

  if (role.id === guild.id) {
    await ctx.reply({
      embeds: [errorEmbed('Invalid role', '@everyone cannot be used as the birthday role.')],
    });
    return;
  }

  if (role.managed) {
    await ctx.reply({
      embeds: [
        errorEmbed(
          'Invalid role',
          'That role is managed by an integration and cannot be assigned manually.',
        ),
      ],
    });
    return;
  }

  const me = guild.members.me;

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await ctx.reply({
      embeds: [errorEmbed('Missing permissions', 'I need the **Manage Roles** permission.')],
    });
    return;
  }

  if (me.roles.highest.position <= role.position) {
    await ctx.reply({
      embeds: [
        errorEmbed(
          'Role hierarchy problem',
          `My highest role (${me.roles.highest}) must sit above ${role} in the role list. Move my role higher under Server Settings → Roles.`,
        ),
      ],
    });
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

  await ctx.reply({
    embeds: [
      successEmbed(
        'Birthday role set',
        `${role} will be given on a member's birthday and removed the following day.`,
      ),
    ],
  });
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
        ephemeral({
          embeds: [
            errorEmbed(
              'Missing permissions',
              'Only members with **Manage Server** can change the server default.',
            ),
          ],
        }),
      );
      return;
    }

    if (!input.zone) {
      store.setGuildTimezone(guild.id, null);
      await reconcileGuild(guild);

      await ctx.reply({
        embeds: [
          successEmbed(
            'Server default reset',
            `Members without their own time zone now use **${config.timezone}**.`,
          ),
        ],
      });
      return;
    }

    if (!isValidTimeZone(input.zone)) {
      await ctx.reply({
        embeds: [
          errorEmbed(
            'Invalid time zone',
            `"${input.zone}" is not a valid IANA time zone. Try something like \`Europe/Berlin\` or \`America/New_York\`.`,
          ),
        ],
      });
      return;
    }

    store.setGuildTimezone(guild.id, input.zone);
    await reconcileGuild(guild);

    await ctx.reply({
      embeds: [
        successEmbed(
          'Server default updated',
          `Members without their own time zone now use **${input.zone}**.\nCurrent time there: ${describeNow(input.zone)}.`,
        ),
      ],
    });
    return;
  }

  const target = input.target;
  const isSelf = target.id === ctx.user.id;
  const who = await displayName(ctx.client, guild, target.id);

  if (!isSelf && !isAdmin(ctx)) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Missing permissions',
            "Only members with **Manage Server** can change someone else's time zone.",
          ),
        ],
      }),
    );
    return;
  }

  if (target.bot) {
    await ctx.reply({
      embeds: [errorEmbed('Invalid member', 'Bots do not have birthdays.')],
    });
    return;
  }

  const birthday = store.getBirthday(guild.id, target.id);

  if (!birthday) {
    const subject = isSelf ? 'You have' : `${who} has`;
    await ctx.reply({
      embeds: [
        errorEmbed(
          'No birthday saved',
          `${subject} not registered a birthday yet. Set it with \`/birthday set\` first.`,
        ),
      ],
    });
    return;
  }

  if (!input.zone) {
    store.setBirthdayTimezone(guild.id, target.id, null);
    await reconcileGuild(guild);

    const fallback = timezoneForGuild(guild.id);

    await ctx.reply({
      embeds: [
        successEmbed(
          isSelf ? 'Time zone reset' : `Time zone reset for ${who}`,
          `Now using the server default: **${fallback}**.`,
        ),
      ],
    });
    return;
  }

  if (!isValidTimeZone(input.zone)) {
    await ctx.reply({
      embeds: [
        errorEmbed(
          'Invalid time zone',
          `"${input.zone}" is not a valid IANA time zone. Try something like \`Europe/Berlin\` or \`America/New_York\`.`,
        ),
      ],
    });
    return;
  }

  store.setBirthdayTimezone(guild.id, target.id, input.zone);
  await reconcileGuild(guild);

  await ctx.reply({
    embeds: [
      successEmbed(
        isSelf ? 'Time zone updated' : `Time zone updated for ${who}`,
        [
          `Birthdays roll over at midnight in **${input.zone}**.`,
          `Current time there: ${describeNow(input.zone)}.`,
        ].join('\n'),
      ),
    ],
  });
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
      ephemeral({
        embeds: [errorEmbed('Missing permissions', 'You need the Manage Server permission.')],
      }),
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
      await ctx.reply({
        embeds: [
          embed({
            title: 'No birthday channel',
            description: 'No greeting channel is configured right now.',
            color: COLORS.muted,
          }),
        ],
      });
      return;
    }

    store.setGuildChannel(guild.id, null);

    await ctx.reply({
      embeds: [successEmbed('Birthday channel cleared', 'Greetings will no longer be posted.')],
    });
    return;
  }

  const channel = ctx.isSlash ? ctx.getChannel('channel') : await resolveChannelArg(ctx);

  if (!channel) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Channel not found',
            `Mention a text channel, for example \`${config.prefix}birthday channel #general\`.`,
          ),
        ],
      }),
    );
    return;
  }

  if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
    await ctx.reply({
      embeds: [errorEmbed('Invalid channel', 'Pick a text or announcement channel.')],
    });
    return;
  }

  const me = guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;

  if (
    permissions &&
    (!permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks))
  ) {
    await ctx.reply({
      embeds: [
        errorEmbed(
          'Missing channel permissions',
          `I cannot post in ${channel}. Grant me **View Channel**, **Send Messages**, and **Embed Links** there.`,
        ),
      ],
    });
    return;
  }

  store.setGuildChannel(guild.id, channel.id);

  const updated = store.getGuildSettings(guild.id);
  const result = await announceBirthdays(guild, updated);
  const fields = [];

  if (result.sent > 0) {
    fields.push({
      name: 'Today',
      value: `Sent ${result.sent} greeting${result.sent === 1 ? '' : 's'} for today's birthdays.`,
    });
  }

  if (result.error) {
    fields.push({
      name: 'Note',
      value: "Saved, but today's greeting could not be posted. Check my permissions in that channel.",
    });
  }

  await ctx.reply({
    embeds: [
      embed({
        title: 'Birthday channel set',
        description: [
          `Greetings will be posted in ${channel}.`,
          `Time zone: **${updated.timezone ?? config.timezone}**.`,
          `Use \`/birthday message\` to customise the text and GIF.`,
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
    builder.setDescription('_Nothing is left after the placeholders are filled in._');
  }

  const rawTemplate =
    template.length > 1000 ? `${template.slice(0, 999)}\u2026` : template;

  builder.addFields(
    { name: 'Template', value: rawTemplate },
    {
      name: 'Placeholders',
      value: PLACEHOLDERS.map(
        (placeholder) => `\`{${placeholder.key}}\` ${placeholder.description}`,
      ).join('\n'),
    },
  );

  if (warning) builder.addFields({ name: 'Warning', value: warning });

  builder.setFooter({
    text: footer ?? `Preview uses your profile · Time zone: ${timeZone}`,
  });

  return builder;
}

async function handleMessage(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Missing permissions', 'You need the Manage Server permission.')],
      }),
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
            title: 'Birthday message',
            footer: `Change it with ${config.prefix}birthday message <text> | <gif> · Time zone: ${timeZone}`,
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
            title: 'Birthday message reset',
            footer: `Default text restored and the GIF removed · Time zone: ${timeZone}`,
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
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid message', problems.join('\n'))] }));
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
      ? `Unknown placeholders will appear literally: ${unknown
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
          title: 'Birthday message updated',
          footer: `Applies from the next greeting · Time zone: ${timeZone}`,
          warning,
        }),
      ],
    }),
  );
}

async function handleSend(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Missing permissions', 'You need the Manage Server permission.')],
      }),
    );
    return;
  }

  const guild = ctx.guild;
  const settings = store.getGuildSettings(guild.id);

  if (!settings.birthdayChannelId) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'No birthday channel',
            'Set one first with `/birthday channel #channel`, then try again.',
          ),
        ],
      }),
    );
    return;
  }

  const target = ctx.isSlash
    ? (ctx.getUser('user') ?? ctx.user)
    : (ctx.message.mentions.users.first() ?? ctx.user);

  const result = await sendGreeting(guild, settings, target.id);

  if (!result.ok) {
    const reasons = {
      'channel-missing': 'The configured channel no longer exists. Set it again with `/birthday channel`.',
      'missing-permissions': 'I need **Send Messages** and **Embed Links** in that channel.',
      'member-missing': 'That member is not in this server.',
      'send-failed': 'Discord rejected the message. Check my permissions in the channel.',
      'no-channel': 'No birthday channel is configured.',
    };

    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Could not send greeting',
            reasons[result.error] ?? 'Something went wrong while posting the greeting.',
          ),
        ],
      }),
    );
    return;
  }

  const ping = result.pingSuppressed
    ? '⚠️ I do not have **Mention Everyone** in that channel, so no ping was sent.'
    : 'Everyone was pinged.';

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Greeting sent',
          `Posted the current template in ${result.channel} for ${target}. ${ping}`,
        ),
      ],
    }),
  );
}

function overviewEmbed(ctx) {
  const settings = store.getGuildSettings(ctx.guildId);
  const timeZone = settings.timezone ?? config.timezone;

  return embed({
    title: 'Birthday commands',
    description: [
      '`/birthday set <month> <day> [year] [user]` — save a birthday (admins: others)',
      '`/birthday remove [user]` - delete a birthday (admins: others)',
      '`/birthday show [visible]` — show or hide the birthday block on your card',
      '`/birthday list` - everyone, nearest first or January to December',
      '`/birthday today` — who is celebrating today',
      '`/birthday next [user]` — countdown for you or someone else',
      '`/birthday role [role]` — admin: choose the birthday role',
      '`/birthday channel [#channel]` — admin: where greetings are posted',
      '`/birthday message [text] [gif]` — admin: greeting text, placeholders, GIF',
      '`/birthday send [user]` - admin: post the greeting now (pings @everyone)',
      '`/birthday timezone [zone] [user]` — per-member time zone (admins: others)',
      '`/birthday timezone default:true [zone]` — admin: server-wide fallback',
      '',
      `Prefix works too: \`${config.prefix}birthday set 5 14\`.`,
    ].join('\n'),
    fields: [
      {
        name: 'Birthday role',
        value: settings.birthdayRoleId ? `<@&${settings.birthdayRoleId}>` : 'Not configured',
        inline: true,
      },
      {
        name: 'Greeting channel',
        value: settings.birthdayChannelId ? `<#${settings.birthdayChannelId}>` : 'Not configured',
        inline: true,
      },
      { name: 'Default time zone', value: timeZone, inline: true },
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Birthday registry, countdowns, automatic role and greetings')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Save or update a birthday')
        .addIntegerOption((option) =>
          option
            .setName('month')
            .setDescription('Month (1-12)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(12),
        )
        .addIntegerOption((option) =>
          option
            .setName('day')
            .setDescription('Day (1-31)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31),
        )
        .addIntegerOption((option) =>
          option
            .setName('year')
            .setDescription('Birth year (optional)')
            .setRequired(false)
            .setMinValue(1900)
            .setMaxValue(new Date().getUTCFullYear()),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription("Admin: set someone else's birthday (Manage Server)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Delete a saved birthday (admins can target someone else)')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription("Admin: remove someone else's birthday (Manage Server)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('show')
        .setDescription('Show or hide your birthday, age and time zone on your profile card')
        .addBooleanOption((option) =>
          option
            .setName('visible')
            .setDescription('Show the block on your card (leave empty to see the current setting)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List every birthday (nearest first, or calendar order)'),
    )
    .addSubcommand((sub) => sub.setName('today').setDescription("Show whose birthday is today"))
    .addSubcommand((sub) =>
      sub
        .setName('next')
        .setDescription("Countdown to your birthday or someone else's")
        .addUserOption((option) =>
          option.setName('user').setDescription('Whose birthday to check').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('role')
        .setDescription('Admin: set the birthday role (leave empty to clear)')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Role to assign').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Admin: channel for birthday greetings (leave empty to clear)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Where greetings are posted')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('message')
        .setDescription('Admin: customise the greeting text and GIF')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('Text with placeholders: {user} {name} {age} {server} {date}')
            .setRequired(false)
            .setMaxLength(2000),
        )
        .addStringOption((option) =>
          option
            .setName('gif')
            .setDescription('Direct GIF/image URL, or "none" to remove it')
            .setRequired(false)
            .setMaxLength(1000),
        )
        .addBooleanOption((option) =>
          option
            .setName('reset')
            .setDescription('Restore the default text and remove the GIF')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('send')
        .setDescription('Admin: post the greeting in the configured channel now')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Who to greet (defaults to you)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('timezone')
        .setDescription('Set a member time zone (leave empty to use the default)')
        .addStringOption((option) =>
          option
            .setName('zone')
            .setDescription('IANA time zone, e.g. Europe/Berlin')
            .setRequired(false)
            .setAutocomplete(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription("Admin: change someone else's time zone")
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName('default')
            .setDescription('Admin: change the server-wide fallback instead')
            .setRequired(false),
        ),
    ),

  name: 'birthday',
  aliases: ['bd', 'bday', 'birthdays'],
  description: 'Birthday registry, countdowns, automatic role and greetings',
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
