import {
  AttachmentBuilder,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { askConfirmation } from '../../lib/confirm.js';
import { errorReply, infoReply, okReply, warnReply } from '../../lib/replies.js';
import { resolveChannel, resolveMember, resolveRole } from '../../lib/resolve.js';
import { parseColor } from '../general/color.js';
import {
  BUTTON_STYLES,
  CLOSE_ACTIONS,
  DEFAULT_PANEL_KEY,
  MAX_NUMBER_START,
  MAX_PANELS,
  claimTicket,
  markTicketDeleted,
  countPanelButtons,
  deleteTicketPanel,
  deleteTicketType,
  ensureTicketPanel,
  getTicketByChannel,
  getTicketPanel,
  getTicketSettings,
  getTicketType,
  listTicketPanels,
  listTicketTypes,
  nextTicketNumber,
  normalizePanelKey,
  normalizeTypeKey,
  openTicketsFor,
  ticketCounts,
  updateTicketSettings,
  upsertTicketPanel,
  upsertTicketType,
} from '../../services/ticket-store.js';
import {
  TicketError,
  closeTicketChannel,
  createTicketChannel,
  ephemeral,
  isStaffMember,
  padTicketNumber,
  publishPanel,
  refreshPanels,
  reopenTicketChannel,
  saveTicketTranscript,
  sanitizeChannelName,
} from '../../services/ticket.js';

function isAdmin(ctx) {
  return Boolean(ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

async function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تضبط التذاكر.')),
  );

  return false;
}

function isClearValue(value) {
  return ['none', 'off', 'clear', '-'].includes(String(value ?? '').trim().toLowerCase());
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseDesignColor(value) {
  if (value === null || value === undefined || isClearValue(value)) return null;

  const parsed = parseColor(String(value));

  if (!parsed) {
    throw new TicketError(`\`${value}\` مو لون. جرّب \`#5865f2\`، \`red\` أو \`none\`.`);
  }

  return parsed.value;
}

function parseButtonStyle(value) {
  if (value === null || value === undefined || isClearValue(value)) return null;

  const style = String(value).toLowerCase();

  if (!BUTTON_STYLES.includes(style)) {
    throw new TicketError(`اختر نمط زر: ${BUTTON_STYLES.join('، ')} أو none.`);
  }

  return style;
}

async function resolveTextChannel(guild, value) {
  if (value === null || value === undefined) return null;
  if (isClearValue(value)) return null;

  const channel = await resolveChannel(guild, value);

  if (!channel) throw new TicketError(`قناة غير معروفة: \`${value}\`.`);
  if (channel.isTextBased?.() === false) throw new TicketError(`<#${channel.id}> مو قناة نصية.`);

  return channel;
}

async function resolveCategory(guild, value) {
  if (value === null || value === undefined) return null;
  if (isClearValue(value)) return null;

  const channel = await resolveChannel(guild, value);

  if (!channel) throw new TicketError(`فئة غير معروفة: \`${value}\`.`);
  if (channel.type !== ChannelType.GuildCategory) {
    throw new TicketError(`<#${channel.id}> مو فئة.`);
  }

  return channel;
}

async function resolveRoleList(guild, value) {
  if (value === null || value === undefined) return [];
  if (isClearValue(value)) return [];

  const tokens = String(value)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const ids = [];

  for (const token of tokens) {
    const role = await resolveRole(guild, token);

    if (!role) throw new TicketError(`رتبة غير معروفة: \`${token}\`.`);
    ids.push(role.id);
  }

  return [...new Set(ids)];
}

function roleList(ids) {
  return ids?.length ? ids.map((id) => `<@&${id}>`).join('، ') : 'ما فيه';
}

function channelLabel(guild, id) {
  return id ? guild?.channels?.cache?.get(id)?.toString?.() ?? `<#${id}>` : 'غير مضبوطة';
}

function parseFlagTokens(args) {
  const flags = {};
  const rest = [];

  for (const token of args) {
    const separator = token.indexOf('=');

    if (separator > 0) {
      flags[token.slice(0, separator).trim().toLowerCase()] = token.slice(separator + 1);
    } else if (token) {
      rest.push(token);
    }
  }

  return { flags, rest };
}

function buttonLine(button) {
  return [
    `**${button.buttonLabel || button.label}** · \`${button.key}\``,
    `اللوحة: \`${button.panelKey}\` · الفئة: ${button.categoryId ? `<#${button.categoryId}>` : '⚠️ غير مضبوطة'}`,
    `التذاكر المقفلة: ${button.closedCategoryId ? `تنقل إلى <#${button.closedCategoryId}>` : 'تبقى في فئة التذاكر'}`,
    `النمط: ${button.buttonStyle ?? 'primary'} · الحد المفتوح: ${button.maxOpen} · الإغلاق: ${button.closeAction}`,
    `الترقيم: ${button.numberStart ? `يبدأ من ${button.numberStart}` : 'من 1'}`,
    `الدعم: ${roleList(button.supportRoleIds)} · المنشن: ${roleList(button.pingRoleIds)}`,
  ].join('\n');
}

function panelLine(guild, panel) {
  const buttons = countPanelButtons(guild.id, panel.key);

  return [
    `الأزرار: **${buttons}**`,
    `الرسالة: ${panel.messageId ? `${channelLabel(guild, panel.channelId)} ([انتقال](https://discord.com/channels/${guild.id}/${panel.channelId}/${panel.messageId}))` : 'ما اننشرت'}`,
    `العنوان: ${panel.title || 'افتراضي'}`,
  ].join('\n');
}

function overviewEmbed() {
  return embed({
    title: 'التذاكر',
    description: [
      'لوحات تذاكر قابلة للتخصيص بالكامل. كل لوحة لها تضمينها الخاص، وأنت تختار الأزرار اللي تنتمي لها.',
      '',
      '**أوامر الأعضاء**',
      '`/ticket close [reason]` — اقفل التذكرة اللي أنت فيها',
      '`/ticket reopen` — رجّع التذكرة المقفلة اللي أنت فيها (فريق الدعم)',
      '`/ticket claim` — استلم تذكرة أو اتركها (فريق الدعم)',
      '`/ticket transcript` — احفظ نسخة المحادثة (صاحب التذكرة أو فريق الدعم)',
      '`/ticket add user:@member` / `/ticket remove user:@member` — إدارة الوصول (فريق الدعم)',
      '`/ticket open [key] [user]` — افتح تذكرة لعضو (فريق الدعم)',
      '`/ticket rename name:...` — غيّر اسم التذكرة (فريق الدعم)',
      '`/ticket delete` — احذف هذي القناة بدون نسخة (فريق الدعم، يطلب تأكيد)',
      '',
      '**اللوحات**',
      '`/ticket panel add key:support label:Support channel:#support` — سوِّ لوحة',
      '`/ticket panel edit key:support title:"Need help?"` — عدّل تضمينها',
      '`/ticket panel post key:support` — انشرها أو حدّثها',
      '`/ticket panel list` — اعرض كل اللوحات',
      '',
      '**الأزرار**',
      '`/ticket button add key:help label:Help panel:support category:#tickets closed_category:#closed` — سوِّ زر',
      '`/ticket button edit key:help panel:support ...` — عدّله أو انقله',
      '`/ticket button remove key:help` — احذفه (يطلب تأكيد)',
      '`/ticket number key:help start:100` — خلّ تذاكر هذا الزر تبدأ من 100',
      '',
      '**إعداد مشترك**',
      '`/ticket list` — اعرض كل لوحة وزر',
      '`/ticket log #channel` — وين تروح النسخ وأحداث التذاكر',
      '',
      'كل قيمة تنقدر تتغيّر بعدين. ما فيه شي ثابت من البداية.',
    ].join('\n'),
    footer: 'كل لوحة تتحمل 25 زر، خمسة في كل صف',
  });
}

async function refreshPostedPanels(ctx) {
  await refreshPanels(ctx.guild).catch(() => null);
}

async function readButtonOptions(ctx, startIndex) {
  const patch = {};
  let key;
  let label;

  if (ctx.isSlash) {
    key = ctx.getString('key');
    label = ctx.getString('label');

    const panel = ctx.getString('panel');
    if (panel !== undefined) patch.panelKey = panel;

    const emoji = ctx.getString('emoji');
    if (emoji !== undefined) patch.emoji = emoji;

    const style = ctx.getString('style');
    if (style !== undefined) patch.buttonStyle = parseButtonStyle(style);

    const buttonLabel = ctx.getString('button_label');
    if (buttonLabel !== undefined) {
      patch.buttonLabel = isClearValue(buttonLabel) ? null : buttonLabel;
    }

    const category = ctx.getChannel('category');
    if (category) {
      if (category.type !== ChannelType.GuildCategory) {
        throw new TicketError('اختر فئة ديسكورد لقناة التذكرة.');
      }

      patch.categoryId = category.id;
    }

    const closedCategory = ctx.getChannel('closed_category');
    if (closedCategory) {
      if (closedCategory.type !== ChannelType.GuildCategory) {
        throw new TicketError('اختر فئة ديسكورد للتذاكر المقفلة.');
      }

      patch.closedCategoryId = closedCategory.id;
    }

    const support = ctx.getString('support_roles');
    if (support !== undefined) patch.supportRoleIds = await resolveRoleList(ctx.guild, support);

    const ping = ctx.getString('ping_roles');
    if (ping !== undefined) patch.pingRoleIds = await resolveRoleList(ctx.guild, ping);

    const log = ctx.getChannel('log_channel');
    if (log) {
      if (log.isTextBased?.() === false) throw new TicketError('اختر قناة نصية للسجل.');
      patch.logChannelId = log.id;
    }

    const welcome = ctx.getString('welcome');
    if (welcome !== undefined) patch.welcomeMessage = isClearValue(welcome) ? '' : welcome;

    const nameTemplate = ctx.getString('name_template');
    if (nameTemplate !== undefined) {
      patch.nameTemplate = isClearValue(nameTemplate) ? '' : nameTemplate;
    }

    const maxOpen = ctx.getInteger('max_open');
    if (maxOpen !== undefined) patch.maxOpen = maxOpen;

    const closeAction = ctx.getString('close_action');
    if (closeAction !== undefined) patch.closeAction = closeAction;

    const color = ctx.getString('color');
    if (color !== undefined) patch.color = parseDesignColor(color);

    const position = ctx.getInteger('position');
    if (position !== undefined) patch.position = position;
  } else {
    const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));
    key = flags.key ?? rest[0];
    label = flags.label;

    if (flags.panel !== undefined || flags.panel_key !== undefined) {
      patch.panelKey = flags.panel ?? flags.panel_key;
    }
    if (flags.emoji !== undefined) patch.emoji = isClearValue(flags.emoji) ? '' : flags.emoji;
    if (flags.style !== undefined || flags.button_style !== undefined) {
      patch.buttonStyle = parseButtonStyle(flags.style ?? flags.button_style);
    }
    if (flags.button !== undefined || flags.button_label !== undefined) {
      const value = flags.button ?? flags.button_label;
      patch.buttonLabel = isClearValue(value) ? null : value;
    }
    if (flags.category !== undefined) {
      const category = await resolveCategory(ctx.guild, flags.category);
      patch.categoryId = category?.id ?? null;
    }
    if (flags.closed_category !== undefined || flags.closed !== undefined) {
      const category = await resolveCategory(
        ctx.guild,
        flags.closed_category ?? flags.closed,
      );
      patch.closedCategoryId = category?.id ?? null;
    }
    if (flags.support !== undefined || flags.support_roles !== undefined) {
      patch.supportRoleIds = await resolveRoleList(ctx.guild, flags.support ?? flags.support_roles);
    }
    if (flags.ping !== undefined || flags.ping_roles !== undefined) {
      patch.pingRoleIds = await resolveRoleList(ctx.guild, flags.ping ?? flags.ping_roles);
    }
    if (flags.log !== undefined || flags.log_channel !== undefined) {
      const channel = await resolveTextChannel(ctx.guild, flags.log ?? flags.log_channel);
      patch.logChannelId = channel?.id ?? null;
    }
    if (flags.welcome !== undefined) {
      patch.welcomeMessage = isClearValue(flags.welcome) ? '' : flags.welcome;
    }
    if (flags.name !== undefined || flags.name_template !== undefined) {
      const value = flags.name ?? flags.name_template;
      patch.nameTemplate = isClearValue(value) ? '' : value;
    }
    if (flags.max !== undefined || flags.max_open !== undefined) {
      const value = Number(flags.max ?? flags.max_open);

      if (!Number.isFinite(value) || value < 1) {
        throw new TicketError('max_open لازم يكون رقم من 1 إلى 10.');
      }

      patch.maxOpen = value;
    }
    if (flags.close !== undefined || flags.close_action !== undefined) {
      const value = String(flags.close ?? flags.close_action).toLowerCase();

      if (!CLOSE_ACTIONS.includes(value)) {
        throw new TicketError(`close_action لازم يكون ${CLOSE_ACTIONS.join(' أو ')}.`);
      }

      patch.closeAction = value;
    }
    if (flags.color !== undefined) patch.color = parseDesignColor(flags.color);

    if (flags.position !== undefined) {
      const value = Number(flags.position);

      if (!Number.isFinite(value)) {
        throw new TicketError('position لازم يكون رقم من 0 إلى 99.');
      }

      patch.position = Math.max(0, Math.min(99, Math.trunc(value)));
    }
  }

  return { key, label, patch };
}

/** Resolves the panel a button belongs to, creating the default one if needed. */
function resolvePanelForButton(guildId, rawKey, { create = true } = {}) {
  if (rawKey !== undefined && !normalizePanelKey(rawKey)) {
    throw new TicketError('مفتاح اللوحة يحتاج حروف أو أرقام أو `-` أو `_`.');
  }

  const normalized = normalizePanelKey(rawKey ?? '') || DEFAULT_PANEL_KEY;
  const before = getTicketPanel(guildId, normalized);

  if (before) return { panel: before, created: false };
  if (!create) return { panel: null, created: false };

  return { panel: ensureTicketPanel(guildId, normalized), created: true };
}

async function handleButtonAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const { key, label, patch } = await readButtonOptions(ctx, 2);
    const normalized = normalizeTypeKey(key);

    if (!normalized) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'ما فيه مفتاح',
            'استخدم `/ticket button add key:general label:Support panel:main category:#tickets`.',
          ),
        ),
      );
      return;
    }

    if (getTicketType(ctx.guildId, normalized)) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'هذا المفتاح موجود',
            `عدّله بـ \`/ticket button edit key:${normalized} ...\`.`,
          ),
        ),
      );
      return;
    }

    if (!String(label ?? '').trim()) {
      await ctx.fail(
        ephemeral(errorReply('ما فيه اسم', 'الزر يحتاج اسم، مثلاً `label:Support`.')),
      );
      return;
    }

    if (!patch.categoryId) {
      await ctx.fail(
        ephemeral(
          errorReply('ما فيه فئة', 'حدد وين هذا الزر يسوي قنوات التذاكر بـ `category:#category`.'),
        ),
      );
      return;
    }

    const { panel, created } = resolvePanelForButton(ctx.guildId, patch.panelKey);
    patch.panelKey = panel.key;

    const button = upsertTicketType(ctx.guildId, normalized, { ...patch, label });
    await refreshPostedPanels(ctx);

    await ctx.reply(
      ephemeral(
        okReply(
          `انضاف الزر · ${button.buttonLabel || button.label}`,
          [
            buttonLine(button),
            '',
            created
              ? `ان سوّت له لوحة \`${panel.key}\`. زيّنها بـ \`/ticket panel edit key:${panel.key} title:"..."\` وانشرها بـ \`/ticket panel post key:${panel.key} channel:#channel\`.`
              : 'تحدّثت اللوحة المنشورة تلقائيًا. عدّل الزر بـ `/ticket button edit`.',
          ].join('\n'),
        ),
      ),
    );
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أضيف الزر', error.message)));
  }
}

async function handleButtonEdit(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const { key, label, patch } = await readButtonOptions(ctx, 2);
    const normalized = normalizeTypeKey(key);
    const existing = normalized ? getTicketType(ctx.guildId, normalized) : null;

    if (!existing) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'زر غير معروف',
            `ما فيه زر اسمه \`${key || '?'}\`. أضفه أول بـ \`/ticket button add\`.`,
          ),
        ),
      );
      return;
    }

    if (label !== undefined) patch.label = label;

    if (patch.panelKey !== undefined) {
      patch.panelKey = resolvePanelForButton(ctx.guildId, patch.panelKey).panel.key;
    }

    const button = upsertTicketType(ctx.guildId, normalized, patch);
    await refreshPostedPanels(ctx);

    await ctx.reply(
      ephemeral(
        okReply(
          `انحفظ الزر · ${button.buttonLabel || button.label}`,
          `${buttonLine(button)}\n\nتحدّثت اللوحات المنشورة تلقائيًا.`,
        ),
      ),
    );
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أحفظ الزر', error.message)));
  }
}

async function handleButtonRemove(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const key = ctx.isSlash ? ctx.getString('key') : parseFlagTokens(ctx.args.slice(2)).flags.key ?? parseFlagTokens(ctx.args.slice(2)).rest[0];
  const confirmed = ctx.isSlash ? ctx.getBoolean('confirm') : parseFlagTokens(ctx.args.slice(2)).flags.confirm !== undefined || ctx.args.includes('confirm');
  const normalized = normalizeTypeKey(key);
  const button = normalized ? getTicketType(ctx.guildId, normalized) : null;

  if (!button) {
    await ctx.fail(
      ephemeral(errorReply('زر غير معروف', `ما فيه زر اسمه \`${key || '?'}\`.`)),
    );
    return;
  }

  const open = openTicketsFor(ctx.guildId, null, button.key).length;

  if (open > 0) {
    await ctx.fail(
      ephemeral(
        warnReply(
          'فيه تذاكر مفتوحة',
          `اقفل ${open} تذكرة مفتوحة لهذا الزر قبل ما تحذفه.`,
        ),
      ),
    );
    return;
  }

  // Deletion is what the confirmation gates, so the checks run again when the
  // member answers: two minutes is enough time for a ticket to open or for
  // another admin to remove the button.
  const removeButton = async () => {
    if (!getTicketType(ctx.guildId, button.key)) {
      await ctx.reply(
        ephemeral(warnReply('الزر انحذف', `\`${button.key}\` ما عاد موجود في اللوحة.`)),
      );
      return;
    }

    const stillOpen = openTicketsFor(ctx.guildId, null, button.key).length;

    if (stillOpen > 0) {
      await ctx.reply(
        ephemeral(
          warnReply(
            'فيه تذاكر مفتوحة',
            `انفتحت ${stillOpen} تذكرة لهذا الزر. اقفلها قبل ما تحذفه.`,
          ),
        ),
      );
      return;
    }

    deleteTicketType(ctx.guildId, button.key);
    await refreshPostedPanels(ctx);

    await ctx.reply(
      okReply('انحذف الزر', `انشال \`${button.key}\` من اللوحة \`${button.panelKey}\`.`),
    );
  };

  if (!confirmed) {
    await askConfirmation({
      ctx,
      prompt: `هذا يحذف الزر \`${button.key}\` من اللوحة \`${button.panelKey}\`.`,
      run: removeButton,
    });
    return;
  }

  await removeButton();
}

async function handleNumber(ctx) {
  if (!(await requireAdmin(ctx))) return;

  let rawKey;
  let rawStart;

  if (ctx.isSlash) {
    rawKey = ctx.getString('key') ?? '';
    rawStart = ctx.getInteger('start');
  } else {
    const { flags, rest } = parseFlagTokens(ctx.args.slice(1));

    rawKey = flags.key ?? flags.button ?? flags.type ?? rest[0] ?? '';
    rawStart = flags.start ?? flags.number ?? rest[1];
  }

  const key = normalizeTypeKey(rawKey);

  if (!key) {
    const buttons = listTicketTypes(ctx.guildId);

    await ctx.reply({
      embeds: [
        embed({
          title: 'أرقام تذاكر الأزرار',
          description: buttons.length
            ? 'كل زر يعدّ لحاله. اختر واحد بـ `/ticket number key:<key> start:<n>`.'
            : 'ما فيه أزرار بعد. أضف واحد بـ `/ticket button add ...`.',
          fields: buttons.slice(0, 25).map((button) => ({
            name: `${button.buttonLabel || button.label} · ${button.key}`,
            value: `يبدأ من **${button.numberStart}** · التذكرة الجاية **#${padTicketNumber(nextTicketNumber(ctx.guildId, button.key))}**`,
          })),
          color: COLORS.primary,
          footer: `أرقام البداية من 0 إلى ${MAX_NUMBER_START}؛ 0 يعني العد من 1`,
        }),
      ],
    });
    return;
  }

  const button = getTicketType(ctx.guildId, key);

  if (!button) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'زر غير معروف',
          `ما فيه زر اسمه \`${rawKey || '?'}\`. أضفه بـ \`/ticket button add key:${key} label:... category:#category\`.`,
        ),
      ),
    );
    return;
  }

  if (rawStart === undefined || rawStart === null || rawStart === '') {
    await ctx.reply({
      embeds: [
        embed({
          title: `أرقام التذاكر · ${button.buttonLabel || button.label}`,
          description: [
            `المفتاح: \`${button.key}\``,
            `يبدأ من: **${button.numberStart}**${button.numberStart ? '' : ' (يعد من 1)'}`,
            `التذكرة الجاية: **#${padTicketNumber(nextTicketNumber(ctx.guildId, button.key))}**`,
            '',
            `غيّره بـ \`/ticket number key:${button.key} start:100\`.`,
          ].join('\n'),
          color: COLORS.primary,
        }),
      ],
    });
    return;
  }

  const start = Number(rawStart);

  if (!Number.isInteger(start) || start < 0 || start > MAX_NUMBER_START) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'رقم غير صالح',
          `استخدم رقم صحيح من 0 إلى ${MAX_NUMBER_START}. \`0\` يعد من 1.`,
        ),
      ),
    );
    return;
  }

  const updated = upsertTicketType(ctx.guildId, key, { numberStart: start });
  const next = nextTicketNumber(ctx.guildId, updated.key);

  await ctx.reply(
    okReply(
      `انضبط الترقيم · ${updated.buttonLabel || updated.label}`,
      [
        start === 0
          ? `\`${updated.key}\` الحين يعد من 1.`
          : `\`${updated.key}\` الحين يبدأ من **${start}**.`,
        `التذكرة الجاية من هذا الزر بتكون **#${padTicketNumber(next)}**.`,
        `التذاكر الموجودة تحتفظ بأرقامها. شغّل \`/ticket number key:${updated.key}\` عشان تتأكد.`,
      ].join('\n'),
    ),
  );
}

async function handleButtonList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const buttons = listTicketTypes(ctx.guildId);
  const panels = listTicketPanels(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'أزرار اللوحات',
        description: buttons.length
          ? `**${buttons.length}** زر موزّعين على **${panels.length}** لوحة. كل زر يظهر في لوحته بس.`
          : 'ما فيه أزرار بعد. أضف واحد بـ `/ticket button add key:general label:Support panel:main category:#tickets`.',
        fields: buttons.map((button) => ({
          name: `${button.emoji ? `${button.emoji} ` : ''}${button.buttonLabel || button.label} · ${button.key}`,
          value: buttonLine(button),
        })),
        color: COLORS.primary,
        footer: `حتى ${MAX_PANELS} لوحة، و25 زر في كل لوحة`,
      }),
    ],
  });
}

function readPanelDesign(ctx, startIndex) {
  const patch = {};

  if (ctx.isSlash) {
    const label = ctx.getString('label');
    if (label !== undefined) patch.label = isClearValue(label) ? null : label;

    const title = ctx.getString('title');
    if (title !== undefined) patch.title = isClearValue(title) ? null : title;

    const description = ctx.getString('description');
    if (description !== undefined) {
      patch.description = isClearValue(description) ? null : description;
    }

    const footer = ctx.getString('footer');
    if (footer !== undefined) patch.footer = isClearValue(footer) ? null : footer;

    const image = ctx.getString('image');
    if (image !== undefined) patch.image = isClearValue(image) ? null : image;

    const thumbnail = ctx.getString('thumbnail');
    if (thumbnail !== undefined) patch.thumbnail = isClearValue(thumbnail) ? null : thumbnail;

    const color = ctx.getString('color');
    if (color !== undefined) patch.color = parseDesignColor(color);

    const position = ctx.getInteger('position');
    if (position !== undefined) patch.position = position;
  } else {
    const { flags } = parseFlagTokens(ctx.args.slice(startIndex));

    for (const [key, field] of [
      ['label', 'label'],
      ['title', 'title'],
      ['description', 'description'],
      ['footer', 'footer'],
      ['image', 'image'],
      ['thumbnail', 'thumbnail'],
    ]) {
      if (flags[key] !== undefined) {
        patch[field] = isClearValue(flags[key]) ? null : flags[key];
      }
    }

    if (flags.color !== undefined) patch.color = parseDesignColor(flags.color);

    if (flags.position !== undefined) {
      const value = Number(flags.position);

      if (!Number.isFinite(value)) {
        throw new TicketError('position لازم يكون رقم من 0 إلى 99.');
      }

      patch.position = Math.max(0, Math.min(99, Math.trunc(value)));
    }
  }

  for (const field of ['image', 'thumbnail']) {
    if (patch[field] && !isHttpUrl(patch[field])) {
      throw new TicketError(`حقل ${field} لازم يكون رابط صورة http(s).`);
    }
  }

  return patch;
}

/** Reads the panel key from a slash option or a prefix flag/argument. */
function readPanelKey(ctx, startIndex, fallback = null) {
  if (ctx.isSlash) return ctx.getString('key') ?? fallback;

  const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));

  return flags.key ?? flags.panel ?? rest[0] ?? fallback;
}

async function readPanelChannel(ctx, { startIndex = 2, positional = null } = {}) {
  if (ctx.isSlash) return ctx.getChannel('channel') ?? null;

  const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));
  let raw = flags.channel ?? flags.ch;

  if (raw === undefined && positional !== null) raw = rest[positional];
  if (!raw) return null;

  return resolveTextChannel(ctx.guild, raw);
}

async function panelChannelById(guild, channelId) {
  if (!channelId) return null;

  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

async function handlePanelAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const rawKey = readPanelKey(ctx, 2);
    const key = normalizePanelKey(rawKey);

    if (!key) {
      await ctx.fail(
        ephemeral(errorReply('ما فيه مفتاح', 'استخدم `/ticket panel add key:support label:Support`.')),
      );
      return;
    }

    if (getTicketPanel(ctx.guildId, key)) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'هذي اللوحة موجودة',
            `غيّرها بـ \`/ticket panel edit key:${key} ...\`.`,
          ),
        ),
      );
      return;
    }

    if (listTicketPanels(ctx.guildId).length >= MAX_PANELS) {
      await ctx.fail(
        ephemeral(
          errorReply('لوحات كثيرة', `السيرفر يقدر يكون فيه ${MAX_PANELS} لوحات كحد أقصى.`),
        ),
      );
      return;
    }

    const patch = readPanelDesign(ctx, 2);
    const channel = await readPanelChannel(ctx, { startIndex: 2 });
    const panel = upsertTicketPanel(ctx.guildId, key, patch);
    let message = null;

    if (channel) message = await publishPanel(ctx.guild, channel, key);

    await ctx.reply(
      ephemeral(
        okReply(
          `ان سوّت اللوحة · ${panel.label}`,
          [
            `المفتاح: \`${panel.key}\` · الأزرار: **${countPanelButtons(ctx.guildId, key)}**`,
            message
              ? `الحين شغالة في ${channel} ([انتقال](${message.url ?? '#'})).`
              : `انشرها بـ \`/ticket panel post key:${panel.key} channel:#channel\`.`,
            `أضف أزرار بـ \`/ticket button add key:help label:Help panel:${panel.key} category:#tickets\`.`,
          ].join('\n'),
        ),
      ),
    );
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أسوي اللوحة', error.message)));
  }
}

async function handlePanelEdit(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const rawKey = readPanelKey(ctx, 2);
    const key = normalizePanelKey(rawKey);

    if (!key) {
      await ctx.fail(
        ephemeral(
          errorReply('ما فيه لوحة', 'استخدم `/ticket panel edit key:support title:"..."`.'),
        ),
      );
      return;
    }

    const existing = getTicketPanel(ctx.guildId, key);

    if (!existing) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'لوحة غير معروفة',
            `ما فيه لوحة اسمها \`${rawKey || '?'}\`. سوّها بـ \`/ticket panel add key:${key || 'key'}\`.`,
          ),
        ),
      );
      return;
    }

    const patch = readPanelDesign(ctx, 2);
    const channel = await readPanelChannel(ctx, { startIndex: 2 });
    const panel = upsertTicketPanel(ctx.guildId, key, patch);
    let message = null;

    if (channel) {
      message = await publishPanel(ctx.guild, channel, key);
    } else {
      const saved = await panelChannelById(ctx.guild, panel.channelId);

      if (saved) message = await publishPanel(ctx.guild, saved, key).catch(() => null);
    }

    await ctx.reply(
      ephemeral(
        okReply(
          `انحفظت اللوحة · ${panel.label}`,
          [
            `المفتاح: \`${panel.key}\` · الأزرار: **${countPanelButtons(ctx.guildId, key)}**`,
            message
              ? `تحدّثت اللوحة المنشورة ([انتقال](${message.url ?? '#'})).`
              : `انشرها بـ \`/ticket panel post key:${panel.key} channel:#channel\`.`,
          ].join('\n'),
        ),
      ),
    );
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أحفظ اللوحة', error.message)));
  }
}

async function handlePanelPost(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const actionKnown = ['post', 'publish'].includes(String(ctx.args[1] ?? '').toLowerCase());
    const startIndex = ctx.isSlash ? 0 : actionKnown ? 2 : 1;
    const patch = readPanelDesign(ctx, startIndex);

    let rawKey;

    if (ctx.isSlash) {
      rawKey = ctx.getString('key') ?? DEFAULT_PANEL_KEY;
    } else {
      const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));

      rawKey = flags.key ?? flags.panel ?? (actionKnown ? rest[0] : null) ?? DEFAULT_PANEL_KEY;
    }

    const key = normalizePanelKey(rawKey) || DEFAULT_PANEL_KEY;

    if (!getTicketPanel(ctx.guildId, key)) upsertTicketPanel(ctx.guildId, key, {});
    if (Object.keys(patch).length > 0) upsertTicketPanel(ctx.guildId, key, patch);

    const panel = getTicketPanel(ctx.guildId, key);
    let channel = await readPanelChannel(ctx, {
      startIndex,
      positional: actionKnown ? null : 0,
    });

    if (!channel) channel = await panelChannelById(ctx.guild, panel.channelId);
    if (!channel) channel = ctx.channel;

    if (!channel?.isTextBased?.()) {
      await ctx.fail(
        ephemeral(errorReply('ما فيه قناة', 'اختر قناة نصية للوحة.')),
      );
      return;
    }

    const buttons = listTicketTypes(ctx.guildId, key);
    const message = await publishPanel(ctx.guild, channel, key);

    await ctx.reply(
      ephemeral(
        okReply(
          `اننشرت اللوحة · ${panel.label}`,
          [
            `الحين شغالة في ${channel} ([انتقال](${message.url ?? '#'})).`,
            buttons.length
              ? `فيها **${buttons.length}** زر وتستخدم تضمينك المخصص.`
              : `ما فيها أزرار بعد. أضف واحد بـ \`/ticket button add ... panel:${key}\`.`,
          ].join('\n'),
        ),
      ),
    );
  } catch (error) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما قدرت أنشر اللوحة',
          error instanceof TicketError
            ? error.message
            : `تأكد إني أقدر **عرض القنوات**، **إرسال الرسائل** و**إرفاق الروابط** في القناة. ${error.message}`,
        ),
      ),
    );
  }
}

async function handlePanelList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const panels = listTicketPanels(ctx.guildId);
  const buttons = listTicketTypes(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'لوحات التذاكر',
        description: panels.length
          ? [
              `**${panels.length}** لوحة · **${buttons.length}** زر.`,
              `قناة السجل: ${channelLabel(ctx.guild, getTicketSettings(ctx.guildId).logChannelId)}`,
            ].join('\n')
          : 'ما فيه لوحات بعد. سوِّ واحدة بـ `/ticket panel add key:main label:Main`.',
        fields: panels.map((panel) => {
          const members = buttons.filter((button) => button.panelKey === panel.key);

          return {
            name: `${panel.label} · ${panel.key}`,
            value: [
              panelLine(ctx.guild, panel),
              members.length
                ? members
                    .map((button) => `• ${button.buttonLabel || button.label} (\`${button.key}\`)`)
                    .join('\n')
                : '• ما فيه أزرار بعد',
            ]
              .join('\n')
              .slice(0, 1024),
          };
        }),
        color: COLORS.primary,
        footer: 'عدّل لوحة بـ /ticket panel edit، أو زر بـ /ticket button edit',
      }),
    ],
  });
}

async function handlePanelRemove(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const rawKey = readPanelKey(ctx, 2);
  const key = normalizePanelKey(rawKey);
  const panel = key ? getTicketPanel(ctx.guildId, key) : null;
  const { flags } = ctx.isSlash ? { flags: {} } : parseFlagTokens(ctx.args.slice(2));
  const confirmed = ctx.isSlash
    ? ctx.getBoolean('confirm')
    : flags.confirm !== undefined || ctx.args.includes('confirm');

  if (!panel) {
    await ctx.fail(
      ephemeral(errorReply('لوحة غير معروفة', `ما فيه لوحة اسمها \`${rawKey || '?'}\`.`)),
    );
    return;
  }

  const buttons = listTicketTypes(ctx.guildId, panel.key);
  const open = buttons
    .map((button) => ({ button, count: openTicketsFor(ctx.guildId, null, button.key).length }))
    .filter((entry) => entry.count > 0);

  if (open.length > 0) {
    await ctx.fail(
      ephemeral(
        warnReply(
          'فيه تذاكر مفتوحة',
          `اقفل التذاكر المفتوحة قبل ما تحذف هذي اللوحة:\n${open
            .map((entry) => `• \`${entry.button.key}\` (${entry.count})`)
            .join('\n')}`,
        ),
      ),
    );
    return;
  }

  const removePanel = async () => {
    if (!getTicketPanel(ctx.guildId, panel.key)) {
      await ctx.reply(
        ephemeral(warnReply('اللوحة انحذفت', `\`${panel.key}\` ما عادت موجودة.`)),
      );
      return;
    }

    const currentButtons = listTicketTypes(ctx.guildId, panel.key);
    const stillOpen = currentButtons
      .map((button) => ({ button, count: openTicketsFor(ctx.guildId, null, button.key).length }))
      .filter((entry) => entry.count > 0);

    if (stillOpen.length > 0) {
      await ctx.reply(
        ephemeral(
          warnReply(
            'فيه تذاكر مفتوحة',
            `انفتحت تذاكر لهذي اللوحة. اقفلها قبل ما تحذفها:\n${stillOpen
              .map((entry) => `• \`${entry.button.key}\` (${entry.count})`)
              .join('\n')}`,
          ),
        ),
      );
      return;
    }

    if (panel.channelId && panel.messageId) {
      const channel = await panelChannelById(ctx.guild, panel.channelId);
      const message = channel?.messages?.fetch
        ? await channel.messages.fetch(panel.messageId).catch(() => null)
        : null;

      if (message) await message.delete().catch(() => null);
    }

    for (const button of currentButtons) deleteTicketType(ctx.guildId, button.key);
    deleteTicketPanel(ctx.guildId, panel.key);

    await ctx.reply(
      okReply(
        'انحذفت اللوحة',
        `انشالت \`${panel.key}\` و**${currentButtons.length}** زر معها.`,
      ),
    );
  };

  if (!confirmed) {
    await askConfirmation({
      ctx,
      prompt: `هذا يحذف اللوحة \`${panel.key}\` و**${buttons.length}** زر معها.`,
      run: removePanel,
    });
    return;
  }

  await removePanel();
}

async function handleList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const panels = listTicketPanels(ctx.guildId);
  const buttons = listTicketTypes(ctx.guildId);
  const settings = getTicketSettings(ctx.guildId);
  const counts = ticketCounts(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'إعداد التذاكر',
        description: [
          `اللوحات: **${panels.length}** · الأزرار: **${buttons.length}** · المفتوحة: **${counts.open}** · المؤرشفة: **${counts.closed}** · المحذوفة: **${counts.deleted}**`,
          `قناة السجل: ${channelLabel(ctx.guild, settings.logChannelId)}`,
        ].join('\n'),
        fields: panels.map((panel) => {
          const members = buttons.filter((button) => button.panelKey === panel.key);

          return {
            name: `${panel.label} · ${panel.key} · ${members.length} أزرار`,
            value: [
              panelLine(ctx.guild, panel),
              ...members.map(
                (button) =>
                  `• ${button.emoji ? `${button.emoji} ` : ''}${button.buttonLabel || button.label} (\`${button.key}\`) → ${button.categoryId ? `<#${button.categoryId}>` : '⚠️ بدون فئة'}`,
              ),
            ]
              .join('\n')
              .slice(0, 1024),
          };
        }),
        footer:
          'عدّل لوحة بـ /ticket panel edit، أو زر بـ /ticket button edit. حتى 25 زر في اللوحة.',
      }),
    ],
  });
}

async function handleLog(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.isSlash ? ctx.getString('channel') : ctx.args[1];
  const settings = getTicketSettings(ctx.guildId);

  if (ctx.isSlash) {
    const channel = ctx.getChannel('channel');

    if (!channel) {
      await ctx.reply(
        ephemeral({
          embeds: [
            embed({
              title: 'سجل التذاكر',
              description: `قناة السجل الحالية: ${channelLabel(ctx.guild, settings.logChannelId)}`,
              color: COLORS.primary,
            }),
          ],
        }),
      );
      return;
    }

    if (channel.isTextBased?.() === false) {
      await ctx.fail(ephemeral(errorReply('قناة غير صالحة', 'اختر قناة نصية.')));
      return;
    }

    updateTicketSettings(ctx.guildId, { logChannelId: channel.id });
    await ctx.reply(
      ephemeral(
        okReply('انضبط سجل التذاكر', `النسخ وأحداث التذاكر الحين تروح إلى ${channel}.`),
      ),
    );
    return;
  }

  if (!raw) {
    await ctx.reply({
      embeds: [
        embed({
          title: 'سجل التذاكر',
          description: `قناة السجل الحالية: ${channelLabel(ctx.guild, settings.logChannelId)}`,
          color: COLORS.primary,
        }),
      ],
    });
    return;
  }

  try {
    const channel = await resolveTextChannel(ctx.guild, raw);
    updateTicketSettings(ctx.guildId, { logChannelId: channel?.id ?? null });
    await ctx.reply(
      okReply(
        channel ? 'انضبط سجل التذاكر' : 'انمسح سجل التذاكر',
        channel
          ? `النسخ وأحداث التذاكر الحين تروح إلى ${channel}.`
          : 'التذاكر المقفلة الحين تنؤرشف بدال ما تنحذف.',
      ),
    );
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أضبط قناة السجل', error.message)));
  }
}

function ticketContext(ctx) {
  const ticket = getTicketByChannel(ctx.guildId, ctx.channelId);

  if (!ticket) throw new TicketError('هذي القناة مو تذكرة.');

  return { ticket, type: getTicketType(ctx.guildId, ticket.typeKey) };
}

/**
 * `/ticket open [key] [user]` (prefix `:-ticket open [key] [@user]`) opens a
 * ticket on behalf of a member. Without a key the only button is used; with
 * several buttons the key is required so the right category/roles are picked.
 */
async function handleOpen(ctx) {
  const current = getTicketByChannel(ctx.guildId, ctx.channelId);

  if (current) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'أنت داخل تذكرة أصلًا',
          'استخدم `/ticket reopen` عشان ترجّع هذي التذكرة، أو `/ticket close` عشان تقفلها. `/ticket open` يسوي تذكرة في قناة عادية.',
        ),
      ),
    );
    return;
  }

  const buttons = listTicketTypes(ctx.guildId);

  if (buttons.length === 0) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما فيه أزرار تذاكر',
          'سوِّ واحد بـ `/ticket button add key:help label:Help category:#tickets`.',
        ),
      ),
    );
    return;
  }

  let rawKey;
  let target;

  if (ctx.isSlash) {
    rawKey = ctx.getString('key');
    target = ctx.getMember('user') ?? ctx.getUser('user') ?? ctx.member ?? ctx.user;
  } else {
    const { flags, rest } = parseFlagTokens(ctx.args.slice(1));
    const mention = rest.find((entry) => /^<@!?\d+>$/.test(entry));
    const plain = rest.find((entry) => !/^<@!?\d+>$/.test(entry));

    rawKey = flags.key ?? flags.button ?? plain;

    if (flags.user ?? mention) {
      target = await resolveMember(ctx.guild, flags.user ?? mention, ctx.message).catch(
        () => null,
      );

      if (!target) {
        await ctx.fail(
          ephemeral(errorReply('ما لقيت العضو', 'اذكر العضو اللي التذكرة له.')),
        );
        return;
      }
    } else {
      target = ctx.member ?? ctx.user;
    }
  }

  const wanted = normalizeTypeKey(rawKey ?? '');
  const type = wanted
    ? getTicketType(ctx.guildId, wanted)
    : buttons.length === 1
      ? buttons[0]
      : null;

  if (!type) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'اختر زر',
          `هذا السيرفر فيه أكثر من زر تذاكر. استخدم \`/ticket open key:<key>\` مع واحد من: ${buttons.map((button) => `\`${button.key}\``).join('، ')}.`,
        ),
      ),
    );
    return;
  }

  if (!isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يفتح تذكرة لعضو.')),
    );
    return;
  }

  const opener = target?.user ?? target ?? ctx.user;

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const { ticket, channel } = await createTicketChannel({
      guild: ctx.guild,
      user: opener,
      typeKey: type.key,
    });
    const payload = {
      ...okReply(
        'انفتحت التذكرة',
        `تذكرة #${padTicketNumber(ticket.number)} لـ <@${opener.id}>: <#${channel.id}>.`,
      ),
      allowedMentions: { parse: [] },
    };

    if (ctx.isSlash) await ctx.editReply(payload);
    else await ctx.reply(payload);
  } catch (error) {
    const embed = errorReply(
      'ما قدرت أفتح التذكرة',
      error instanceof TicketError ? error.message : 'صار خطأ.',
    );

    if (ctx.isSlash) await ctx.editReply(embed).catch(() => null);
    else await ctx.reply(embed).catch(() => null);
  }
}

/**
 * `/ticket reopen` (prefix `:-ticket reopen`) reopens the closed ticket in the
 * current channel. `/ticket close` closes an open ticket; the two are opposites.
 */
async function handleReopen(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  const { ticket, type } = context;

  if (!isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يرجّع تذكرة.')),
    );
    return;
  }

  if (ticket.status === 'open') {
    await ctx.fail(
      ephemeral(
        errorReply('مفتوحة أصلًا', 'هذي التذكرة مفتوحة. استخدم `/ticket close` عشان تقفلها.'),
      ),
    );
    return;
  }

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });
  else await ctx.typing();

  try {
    await reopenTicketChannel({
      guild: ctx.guild,
      channel: ctx.channel,
      ticket,
      type,
    });
  } catch (error) {
    const payload = errorReply(
      'ما قدرت أرجّع التذكرة',
      error instanceof TicketError ? error.message : 'صار خطأ.',
    );

    if (ctx.isSlash) await ctx.editReply(payload).catch(() => null);
    else await ctx.reply(payload).catch(() => null);
    return;
  }

  const payload = okReply(
    'رجعت التذكرة',
    `تذكرة #${padTicketNumber(ticket.number)} صارت مفتوحة من جديد.`,
  );

  if (ctx.isSlash) await ctx.editReply(payload);
  else await ctx.reply(payload);
}

/**
 * `/ticket delete confirm:true` force-deletes the current ticket channel. The
 * regular close flow keeps a transcript; this is the "remove it now" escape
 * hatch, so it asks for confirmation and says the transcript is skipped.
 */
async function handleTicketDelete(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  const { ticket, type } = context;

  if (!isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يحذف تذكرة.')),
    );
    return;
  }

  const confirmed = ctx.isSlash
    ? Boolean(ctx.getBoolean('confirm'))
    : ctx.args.includes('confirm') ||
      parseFlagTokens(ctx.args.slice(1)).flags.confirm !== undefined;

  const deleteTicket = async () => {
    if (!isStaffMember(ctx.guild, ctx.member, type)) {
      await ctx.reply(
        ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يحذف تذكرة.')),
      );
      return;
    }

    if (ctx.isSlash) await ctx.defer({ ephemeral: true });
    else await ctx.typing();

    try {
      await ctx.channel.delete(`تذكرة حذفها ${ctx.user.tag ?? ctx.user.id}`);
    } catch (error) {
      await ctx.reply(ephemeral(errorReply('ما قدرت أحذف التذكرة', error.message)));
      return;
    }

    markTicketDeleted(ticket.id);

    const payload = okReply(
      'انحذفت التذكرة',
      `تذكرة #${padTicketNumber(ticket.number)} انحذفت.`,
    );

    // The channel no longer exists, so the DM is the only place the caller can
    // see the result.
    if (ctx.user.send) await ctx.user.send(payload).catch(() => null);
  };

  if (!confirmed) {
    await askConfirmation({
      ctx,
      prompt: `هذا يحذف تذكرة #${padTicketNumber(ticket.number)} بدون نسخة ولا رجعة.`,
      run: deleteTicket,
    });
    return;
  }

  await deleteTicket();
}

async function handleClose(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  const { ticket, type } = context;

  if (!isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يقفل التذاكر.')),
    );
    return;
  }

  const reason = ctx.isSlash ? ctx.getString('reason') ?? '' : ctx.args.slice(1).join(' ');
  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const result = await closeTicketChannel({
      guild: ctx.guild,
      channel: ctx.channel,
      ticket,
      type,
      actor: ctx.user,
      reason,
    });

    const message =
      result.mode === 'delete'
        ? `تذكرة #${String(ticket.number).padStart(4, '0')} انقفلت وانحذفت. النسخة انحفظت.`
        : result.logged
          ? `تذكرة #${String(ticket.number).padStart(4, '0')} انقفلت وانؤرشفت. النسخة انحفظت.`
          : 'انقفلت التذكرة وانؤرشفت. ما فيه قناة سجل مضبوطة، فما انحفظت نسخة.';

    await ctx.editReply(okReply('انقفلت التذكرة', message)).catch(() => null);
  } catch (error) {
    await ctx
      .editReply(
        errorReply(
          'ما قدرت أقفل التذكرة',
          error instanceof TicketError ? error.message : 'صار خطأ.',
        ),
      )
      .catch(() => null);
  }
}

async function handleClaim(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  const { ticket, type } = context;

  if (!isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يستلم التذاكر.')),
    );
    return;
  }

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  if (ticket.claimedBy === ctx.user.id) {
    claimTicket(ticket.id, null);
    await ctx.channel
      .send({
        embeds: [embed({ title: 'التذكرة صارت غير مستلمة', description: 'أي أحد من الفريق يقدر يستلمها من جديد.', color: COLORS.muted })],
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
    await ctx.editReply({ content: 'رجعناها غير مستلمة.' }).catch(() => null);
    return;
  }

  if (ticket.claimedBy) {
    await ctx
      .editReply(
        errorReply('مستلمة من قبل', `هذي التذكرة مستلمها <@${ticket.claimedBy}>.`),
      )
      .catch(() => null);
    return;
  }

  claimTicket(ticket.id, ctx.user.id);
  await ctx.channel
    .send({
      embeds: [
        embed({
          title: 'التذكرة صارت مستلمة',
          description: `الحين يتابعها <@${ctx.user.id}>.`,
          color: COLORS.success,
        }),
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  await ctx.editReply({ content: 'استلمت التذكرة.' }).catch(() => null);
}

async function ticketMember(ctx) {
  const token = ctx.isSlash ? null : ctx.args[1];
  const member = ctx.isSlash
    ? ctx.getMember('user') ?? (ctx.getUser('user') ? await ctx.guild.members.fetch(ctx.getUser('user').id).catch(() => null) : null)
    : await resolveMember(ctx.guild, token, ctx.message).catch(() => null);

  if (!member) throw new TicketError('ما لقيت العضو.');
  if (member.user?.bot) throw new TicketError('البوتات ما تنضاف لتذكرة. اختر شخص.');

  return member;
}

async function handleAddRemove(ctx, add) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  if (!isStaffMember(ctx.guild, ctx.member, context.type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يغيّر وصول التذكرة.')),
    );
    return;
  }

  let member;

  try {
    member = await ticketMember(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('عضو غير صالح', error.message)));
    return;
  }

  if (!add && member.id === context.ticket.openerId) {
    await ctx.fail(
      ephemeral(errorReply('ما ينشال صاحب التذكرة', 'صاحب التذكرة يحتفظ بالوصول دايمًا.')),
    );
    return;
  }

  try {
    await ctx.channel.permissionOverwrites.edit(
      member.id,
      add
        ? {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
          }
        : { ViewChannel: false, SendMessages: false },
      { reason: `${add ? 'Added to' : 'Removed from'} ticket by ${ctx.user.tag ?? ctx.user.id}` },
    );

    await ctx.reply({
      ...okReply(
        add ? 'انضاف العضو' : 'انشال العضو',
        `${member} ${add ? 'الحين يقدر يشوف التذكرة ويكتب فيها.' : 'ما عاد يقدر يشوف هذي التذكرة.'}`,
      ),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أحدّث الوصول', error.message)));
  }
}

async function handleRename(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  if (!isStaffMember(ctx.guild, ctx.member, context.type)) {
    await ctx.fail(
      ephemeral(errorReply('صلاحيات ناقصة', 'فريق الدعم بس يقدر يغيّر اسم التذكرة.')),
    );
    return;
  }

  const raw = ctx.isSlash ? ctx.getString('name') : ctx.args.slice(1).join(' ');
  const name = sanitizeChannelName(raw);

  if (!raw || name === 'ticket') {
    await ctx.fail(
      ephemeral(errorReply('ما فيه اسم', 'استخدم حروف أو أرقام أو `-` أو `_`.')),
    );
    return;
  }

  try {
    await ctx.channel.setName(name, `تذكرة غيّر اسمها ${ctx.user.tag ?? ctx.user.id}`);
    await ctx.reply(okReply('انغيّر اسم التذكرة', `صارت \`${name}\`.`));
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('ما قدرت أغيّر الاسم', error.message)));
  }
}

async function handleTranscript(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail(ephemeral(errorReply('مو تذكرة', error.message)));
    return;
  }

  const { ticket, type } = context;

  if (ticket.openerId !== ctx.user.id && !isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail(
      ephemeral(
        errorReply('صلاحيات ناقصة', 'صاحب التذكرة أو فريق الدعم بس يقدر يصدّر نسخة.'),
      ),
    );
    return;
  }

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const { transcript, log } = await saveTicketTranscript({
      guild: ctx.guild,
      channel: ctx.channel,
      ticket,
      type,
      title: 'نسخة التذكرة',
      color: COLORS.primary,
    });

    if (log) {
      await ctx
        .editReply(
          okReply(
            'انحفظت النسخة',
            `انرسلت إلى ${channelLabel(ctx.guild, log.channelId)} ومعها ${transcript.messages} رسالة.`,
          ),
        )
        .catch(() => null);
      return;
    }

    const payload = {
      content: 'ما فيه قناة سجل مضبوطة، فهذي النسخة مباشرة.',
      files: [new AttachmentBuilder(Buffer.from(transcript.html, 'utf8'), { name: transcript.filename })],
    };

    if (ctx.isSlash) await ctx.editReply(payload).catch(() => null);
    else await ctx.reply(payload).catch(() => null);
  } catch (error) {
    await ctx
      .editReply(
        errorReply(
          'ما قدرت أسوي النسخة',
          error instanceof TicketError ? error.message : 'صار خطأ.',
        ),
      )
      .catch(() => null);
  }
}

function addButtonOptions(sub, { requireLabel = false } = {}) {
  return sub
    .addStringOption((option) =>
      option.setName('key').setDescription('مفتاح قصير للزر، مثل help').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('label').setDescription('الاسم اللي يظهر في التضمين والتذكرة').setRequired(requireLabel),
    )
    .addChannelOption((option) =>
      option
        .setName('category')
        .setDescription('الفئة اللي ينشئ فيها هذا الزر قنوات التذاكر')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(requireLabel),
    )
    .addChannelOption((option) =>
      option
        .setName('closed_category')
        .setDescription('الفئة اللي تنقل لها التذاكر المقفلة (الافتراضي: تبقى)')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('panel')
        .setDescription('اللوحة اللي ينتمي لها الزر (الافتراضي: main)')
        .setAutocomplete(true)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('emoji').setDescription('إيموجي الزر، مثل 🎫').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('button_label').setDescription('نص الزر إذا يختلف عن الاسم').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('style')
        .setDescription('لون الزر')
        .addChoices(
          { name: 'أزرق (أساسي)', value: 'primary' },
          { name: 'رمادي (ثانوي)', value: 'secondary' },
          { name: 'أخضر (نجاح)', value: 'success' },
          { name: 'أحمر (خطر)', value: 'danger' },
        )
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('support_roles').setDescription('رتب تشوف وتدير هذي التذكرة (بينها فاصلة)').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('ping_roles').setDescription('رتب تنمنشن لما تنفتح التذكرة (بينها فاصلة)').setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName('log_channel')
        .setDescription('سجل النسخ والأحداث لهذا الزر')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('welcome').setDescription('نص الترحيب؛ يدعم {mention}، {user}، {server}، {type}، {number}').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('name_template').setDescription('اسم القناة؛ يدعم {number}، {user}، {type}').setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('max_open').setDescription('التذاكر المفتوحة لكل عضو (1–10، الافتراضي 1)').setMinValue(1).setMaxValue(10).setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('close_action')
        .setDescription('احذف القناة بعد الإغلاق أو أرشفها')
        .addChoices(
          { name: 'احذف القناة', value: 'delete' },
          { name: 'أرشف القناة', value: 'archive' },
        )
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('color').setDescription('لون تضمين التذكرة، مثل #5865f2 أو red').setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('position').setDescription('الترتيب في اللوحة (الأصغر أول)').setMinValue(0).setMaxValue(99).setRequired(false),
    );
}

function addPanelOptions(sub, { requireKey = false } = {}) {
  return sub
    .addStringOption((option) =>
      option
        .setName('key')
        .setDescription('مفتاح اللوحة، مثل support')
        .setRequired(requireKey)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('label').setDescription('الاسم اللي يظهر في /ticket panel list').setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('وين تنشر (الافتراضي: القناة المحفوظة أو هذي القناة)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    )
    .addStringOption((option) => option.setName('title').setDescription('عنوان التضمين').setRequired(false))
    .addStringOption((option) =>
      option.setName('description').setDescription('وصف التضمين').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('color').setDescription('لون التضمين، مثل #5865f2 أو red').setRequired(false),
    )
    .addStringOption((option) => option.setName('footer').setDescription('تذييل التضمين').setRequired(false))
    .addStringOption((option) =>
      option.setName('image').setDescription('رابط الصورة الكبيرة (http/https)').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('thumbnail').setDescription('رابط الصورة المصغّرة (http/https)').setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('position').setDescription('الترتيب في /ticket panel list (الأصغر أول)').setMinValue(0).setMaxValue(99).setRequired(false),
    );
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('لوحات تذاكر قابلة للتخصيص، بقنوات خاصة ونسخ محادثة')
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((group) =>
      group
        .setName('button')
        .setDescription('إدارة: ضيف أو عدّل أو احذف أزرار اللوحة')
        .addSubcommand((sub) =>
          addButtonOptions(
            sub.setName('add').setDescription('إدارة: ضيف زر قابل للتخصيص للوحة'),
            { requireLabel: true },
          ),
        )
        .addSubcommand((sub) =>
          addButtonOptions(sub.setName('edit').setDescription('إدارة: عدّل زر واحد')),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('إدارة: احذف زر من اللوحة')
            .addStringOption((option) =>
              option.setName('key').setDescription('مفتاح الزر').setRequired(true).setAutocomplete(true),
            )
            .addBooleanOption((option) =>
              option
                .setName('confirm')
                .setDescription('أكّد فورًا (بدونها يطلب منك كتابة confirm)')
                .setRequired(false),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('panel')
        .setDescription('إدارة: سوِّ لوحات مسمّاة أو عدّلها أو انشرها')
        .addSubcommand((sub) =>
          addPanelOptions(
            sub.setName('add').setDescription('إدارة: سوِّ لوحة مسمّاة بتضمينها الخاص'),
            { requireKey: true },
          ),
        )
        .addSubcommand((sub) =>
          addPanelOptions(
            sub.setName('edit').setDescription('إدارة: عدّل تضمين لوحة أو انقلها'),
            { requireKey: true },
          ),
        )
        .addSubcommand((sub) =>
          addPanelOptions(sub.setName('post').setDescription('إدارة: انشر لوحة أو حدّثها')),
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('إدارة: اعرض كل لوحة وأزرارها'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('إدارة: احذف لوحة وأزرارها')
            .addStringOption((option) =>
              option.setName('key').setDescription('مفتاح اللوحة').setRequired(true).setAutocomplete(true),
            )
            .addBooleanOption((option) =>
              option
                .setName('confirm')
                .setDescription('أكّد فورًا (بدونها يطلب منك كتابة confirm)')
                .setRequired(false),
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('إدارة: اعرض كل لوحة وزر'))
    .addSubcommand((sub) => sub.setName('buttons').setDescription('إدارة: اعرض كل أزرار اللوحات'))
    .addSubcommand((sub) =>
      sub
        .setName('number')
        .setDescription('إدارة: اضبط رقم بداية تذاكر زر')
        .addStringOption((option) =>
          option
            .setName('key')
            .setDescription('مفتاح الزر (فاضي يعرض كل الأزرار)')
            .setAutocomplete(true)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName('start')
            .setDescription('رقم أول تذكرة (0–999999؛ 0 يعني العد من 1)')
            .setMinValue(0)
            .setMaxValue(MAX_NUMBER_START)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('log')
        .setDescription('إدارة: اضبط قناة النسخ وأحداث التذاكر')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('قناة السجل (فاضي يعرض الحالية)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('open')
        .setDescription('افتح تذكرة لعضو (فريق الدعم)')
        .addStringOption((option) =>
          option
            .setName('key')
            .setDescription('أي زر تذاكر (الافتراضي: الوحيد)')
            .setAutocomplete(true)
            .setRequired(false),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('العضو اللي التذكرة له (الافتراضي: أنت)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('اقفل التذكرة في هذي القناة')
        .addStringOption((option) => option.setName('reason').setDescription('سبب الإغلاق (اختياري)').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub.setName('reopen').setDescription('رجّع التذكرة المقفلة في هذي القناة (فريق الدعم)'),
    )
    .addSubcommand((sub) => sub.setName('claim').setDescription('استلم هذي التذكرة أو اتركها (فريق الدعم)'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('ضيف عضو لهذي التذكرة (فريق الدعم)')
        .addUserOption((option) => option.setName('user').setDescription('العضو اللي تنضيفه').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('شيل عضو من هذي التذكرة (فريق الدعم)')
        .addUserOption((option) => option.setName('user').setDescription('العضو اللي تنشيله').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rename')
        .setDescription('غيّر اسم هذي التذكرة (فريق الدعم)')
        .addStringOption((option) => option.setName('name').setDescription('اسم القناة الجديد').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('transcript').setDescription('احفظ نسخة HTML لهذي التذكرة'))
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('احذف قناة التذكرة بدون نسخة (فريق الدعم)')
        .addBooleanOption((option) =>
          option
            .setName('confirm')
            .setDescription('اختر true عشان تحذف القناة الحين')
            .setRequired(false),
        ),
    ),

  name: 'ticket',
  aliases: ['tickets', 'ticket-tool', 'support'],
  description: 'لوحات تذاكر قابلة للتخصيص، بقنوات خاصة ونسخ محادثة',
  category: 'Community',
  usage: 'ticket [button add|edit|remove | panel add|edit|post|list|remove | number|list|buttons|log|open|close|reopen|claim|add|remove|rename|delete|transcript]',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const group = interaction.options.getSubcommandGroup(false);
    const query = String(focused.value ?? '').toLowerCase();

    if (focused.name === 'panel') {
      const panels = listTicketPanels(interaction.guildId)
        .filter(
          (panel) =>
            !query || panel.key.includes(query) || panel.label.toLowerCase().includes(query),
        )
        .slice(0, 25)
        .map((panel) => ({
          name: `${panel.label} (${panel.key})`,
          value: panel.key,
        }));

      await interaction.respond(panels);
      return;
    }

    if (focused.name !== 'key') {
      await interaction.respond([]);
      return;
    }

    if (group === 'panel') {
      const panels = listTicketPanels(interaction.guildId)
        .filter(
          (panel) =>
            !query || panel.key.includes(query) || panel.label.toLowerCase().includes(query),
        )
        .slice(0, 25)
        .map((panel) => ({
          name: `${panel.label} (${panel.key})`,
          value: panel.key,
        }));

      await interaction.respond(panels);
      return;
    }

    const buttons = listTicketTypes(interaction.guildId)
      .filter(
        (button) =>
          !query || button.key.includes(query) || button.label.toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map((button) => ({
        name: `${button.buttonLabel || button.label} (${button.key})`,
        value: button.key,
      }));

    await interaction.respond(buttons);
  },

  async execute(ctx) {
    if (ctx.isSlash) {
      const group = ctx.getSubcommandGroup(false);

      if (group === 'button') {
        const action = ctx.getSubcommand(false);

        if (action === 'add') return handleButtonAdd(ctx);
        if (action === 'edit') return handleButtonEdit(ctx);
        if (action === 'remove') return handleButtonRemove(ctx);

        return ctx.reply({ embeds: [overviewEmbed()] });
      }

      if (group === 'panel') {
        const action = ctx.getSubcommand(false);

        if (action === 'add') return handlePanelAdd(ctx);
        if (action === 'edit') return handlePanelEdit(ctx);
        if (action === 'post') return handlePanelPost(ctx);
        if (action === 'list') return handlePanelList(ctx);
        if (action === 'remove') return handlePanelRemove(ctx);

        return ctx.reply({ embeds: [overviewEmbed()] });
      }

      const subcommand = ctx.getSubcommand(false) ?? '';

      switch (subcommand) {
        case 'list':
          return handleList(ctx);
        case 'buttons':
          return handleButtonList(ctx);
        case 'number':
          return handleNumber(ctx);
        case 'log':
          return handleLog(ctx);
        case 'open':
          return handleOpen(ctx);
        case 'close':
          return handleClose(ctx);
        case 'reopen':
          return handleReopen(ctx);
        case 'claim':
          return handleClaim(ctx);
        case 'add':
          return handleAddRemove(ctx, true);
        case 'remove':
          return handleAddRemove(ctx, false);
        case 'rename':
          return handleRename(ctx);
        case 'delete':
          return handleTicketDelete(ctx);
        case 'transcript':
          return handleTranscript(ctx);
        default:
          return ctx.reply({ embeds: [overviewEmbed()] });
      }
    }

    const subcommand = (ctx.args[0] ?? '').toLowerCase();

    if (subcommand === 'button') {
      const action = (ctx.args[1] ?? '').toLowerCase();

      if (action === 'add') return handleButtonAdd(ctx);
      if (action === 'edit' || action === 'set') return handleButtonEdit(ctx);
      if (action === 'remove' || action === 'delete') return handleButtonRemove(ctx);
      if (action === 'list') return handleButtonList(ctx);

      return ctx.reply({ embeds: [overviewEmbed()] });
    }

    if (subcommand === 'panel') {
      const action = (ctx.args[1] ?? '').toLowerCase();

      if (action === 'add' || action === 'create') return handlePanelAdd(ctx);
      if (action === 'edit' || action === 'set') return handlePanelEdit(ctx);
      if (action === 'post' || action === 'publish') return handlePanelPost(ctx);
      if (action === 'list') return handlePanelList(ctx);
      if (action === 'remove' || action === 'delete') return handlePanelRemove(ctx);

      // `:-ticket panel title=...` keeps working as "edit and post the main panel".
      return handlePanelPost(ctx);
    }

    switch (subcommand) {
      case 'list':
      case 'status':
        return handleList(ctx);
      case 'buttons':
        return handleButtonList(ctx);
      case 'number':
      case 'numbers':
      case 'numbering':
        return handleNumber(ctx);
      case 'log':
        return handleLog(ctx);
      case 'open':
      case 'create':
        return handleOpen(ctx);
      case 'close':
        return handleClose(ctx);
      case 'reopen':
        return handleReopen(ctx);
      case 'claim':
        return handleClaim(ctx);
      case 'add':
        return handleAddRemove(ctx, true);
      case 'remove':
        return handleAddRemove(ctx, false);
      case 'rename':
        return handleRename(ctx);
      case 'delete':
        return handleTicketDelete(ctx);
      case 'transcript':
        return handleTranscript(ctx);
      default:
        return ctx.reply({ embeds: [overviewEmbed()] });
    }
  },
};
