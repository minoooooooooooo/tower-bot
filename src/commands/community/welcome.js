import {
  ActionRowBuilder,
  ChannelType,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { isClearValue, validateImageUrl } from '../../lib/media.js';
import { permissionName } from '../../lib/permissions.js';
import { RLM, ephemeral, errorReply, okReply } from '../../lib/replies.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  STYLES,
  WELCOME_PLACEHOLDERS,
  buildWelcomePayload,
  chooseStyle,
  enabledStyles,
  getStyle,
  modalInputs,
  styleTexts,
  unknownWelcomePlaceholders,
} from '../../services/welcome-styles.js';
import {
  MODES,
  clearWelcomePiece,
  clearWelcomeTexts,
  getWelcomeGifs,
  getWelcomeSettings,
  getWelcomeTexts,
  setWelcomeGif,
  setWelcomePiece,
  updateWelcomeSettings,
} from '../../services/welcome-store.js';

const MODE_LABELS = {
  random: 'عشوائي',
  rotate: 'بالتناوب',
  single: 'نمط واحد',
};

const MODE_NOTES = {
  random: 'عشوائي، وما يتكرر نفس النمط مرتين ورا بعض',
  rotate: 'بالتناوب حسب ترتيب الأنماط',
  single: 'نمط واحد ثابت',
};

function isAdmin(ctx) {
  return Boolean(ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function styleChoices() {
  return STYLES.map((style) => ({ name: style.name, value: style.key }));
}

function resolveStyle(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;

  // Keys stay English (`ledger`, `classic`, …), so an old example like
  // `style:Ledger` still works after the names became Arabic.
  return getStyle(value) ?? STYLES.find((style) => style.name.toLowerCase() === value) ?? null;
}

function styleList() {
  return STYLES.map((style) => style.name).join('، ');
}

/** `<#123>`, a raw id, or `none` to clear. */
function channelIdFromArgs(ctx, index) {
  const raw = ctx.args[index];
  if (!raw) return undefined;

  if (['none', 'off', 'clear', '-'].includes(raw.toLowerCase())) return null;

  const mention = /^<#(\d{17,20})>$/.exec(raw);
  if (mention) return mention[1];

  return /^\d{17,20}$/.test(raw) ? raw : undefined;
}

function channelIdFrom(ctx, name, index) {
  if (ctx.isSlash) {
    const channel = ctx.getChannel(name);
    return channel ? channel.id : undefined;
  }

  return channelIdFromArgs(ctx, index);
}

function channelLabel(guild, id) {
  if (!id) return 'غير مضبوطة';
  return guild?.channels?.cache?.get(id)?.toString?.() ?? `<#${id}>`;
}

async function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;

  await ctx.fail(ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج صلاحية إدارة السيرفر.')));

  return false;
}

function overviewEmbed(ctx) {
  const settings = getWelcomeSettings(ctx.guildId);

  return embed({
    title: 'بطاقات الترحيب',
    description: [
      'ستة أنماط بطاقات، تنختار تلقائيًا لما ينضم عضو.',
      '',
      `\`/welcome channel [#channel]\` — وين تنكتب البطاقات *(${channelLabel(ctx.guild, settings.channelId)})*`,
      '`/welcome mode <random|rotate|single> [style]` — كيف ينختار النمط',
      '`/welcome toggle <style>` — تشغّل نمط أو تطفي',
      '`/welcome list` — الإعداد الحالي والأنماط الشغالة',
      '`/welcome test [style]` — معاينة بطاقة، تشوفها أنت بس',
      '`/welcome gif [style] [url]` — GIF لنمط (`none` يشيله)',
      '`/welcome edit <style>` — تعدّل نص النمط (إدارة)',
      '`/welcome reset [style]` — ترجّع النص الافتراضي (إدارة)',
      '`/welcome links [rules] [general]` — القنوات اللي تستخدمها البطاقات (إدارة)',
      '',
      `المتغيرات: ${WELCOME_PLACEHOLDERS.map((placeholder) => `{${placeholder.key}}`).join(' ')}`,
      '',
      `الأنماط: ${STYLES.map((style) => style.name).join('، ')}`,
    ].join('\n'),
  });
}

async function handleChannel(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const channelId = channelIdFrom(ctx, 'channel', 1);

  if (channelId === undefined) {
    await ctx.fail(
      ephemeral(
        errorReply('ما فيه قناة', 'اذكر قناة، أو اكتب `none` عشان توقف بطاقات الترحيب.'),
      ),
    );
    return;
  }

  if (channelId !== null) {
    const channel =
      ctx.guild.channels.cache.get(channelId) ??
      (await ctx.guild.channels.fetch(channelId).catch(() => null));

    if (!channel || channel.isTextBased?.() === false) {
      await ctx.fail(ephemeral(errorReply('قناة غير صالحة', 'هذي مو قناة نصية.')));
      return;
    }

    const me = ctx.guild.members.me;
    const permissions = me ? channel.permissionsFor?.(me) : null;

    if (
      permissions &&
      !(
        permissions.has(PermissionFlagsBits.SendMessages) &&
        permissions.has(PermissionFlagsBits.EmbedLinks)
      )
    ) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'صلاحيات ناقصة',
            `أحتاج **${permissionName(PermissionFlagsBits.SendMessages)}** و**${permissionName(
              PermissionFlagsBits.EmbedLinks,
            )}** في ${channel}.`,
          ),
        ),
      );
      return;
    }
  }

  updateWelcomeSettings(ctx.guildId, { channelId });

  await ctx.reply(
    ephemeral(
      okReply(
        channelId ? 'انضبطت قناة الترحيب' : 'انطفت بطاقات الترحيب',
        channelId
          ? `الأعضاء الجدد ينرحبون في ${channelLabel(ctx.guild, channelId)}. عاين بـ \`/welcome test\`.`
          : 'ما فيه قناة مضبوطة، فما أحد بينرحب به.',
      ),
    ),
  );
}

async function handleMode(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.isSlash ? ctx.getString('mode') : ctx.args[1]?.toLowerCase();
  const mode = raw === 'random' || raw === 'rotate' || raw === 'single' ? raw : null;

  if (!mode) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'وضع غير صالح',
          `اختر واحد من: ${MODES.map((item) => `\`${item}\``).join('، ')}.`,
        ),
      ),
    );
    return;
  }

  let forcedStyle = null;

  if (mode === 'single') {
    const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[2]);

    if (!style) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'اختر نمط',
            'وضع النمط الواحد يحتاج نمط، مثل `/welcome mode single style:سجل`.',
          ),
        ),
      );
      return;
    }

    forcedStyle = style.key;
  }

  updateWelcomeSettings(ctx.guildId, { mode, forcedStyle });

  await ctx.reply(
    ephemeral(
      okReply(
        'انضبط وضع الترحيب',
        forcedStyle
          ? `كل عضو جديد تجيه بطاقة **${getStyle(forcedStyle).name}**.`
          : `صار الاختيار **${MODE_NOTES[mode]}**.`,
      ),
    ),
  );
}

async function handleToggle(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);

  if (!style) {
    await ctx.fail(
      ephemeral(errorReply('نمط غير معروف', `اختر واحد من: ${styleList()}.`)),
    );
    return;
  }

  const settings = getWelcomeSettings(ctx.guildId);
  const current = enabledStyles(settings);
  const isOn = current.includes(style.key);
  const next = isOn ? current.filter((key) => key !== style.key) : [...current, style.key];

  if (next.length === 0) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'خلّ نمط واحد على الأقل',
          'كل الأنماط بتنطفي. شغّل نمط ثاني أول، أو استخدم `/welcome mode single`.',
        ),
      ),
    );
    return;
  }

  updateWelcomeSettings(ctx.guildId, { enabled: next });

  await ctx.reply(
    ephemeral(
      okReply(
        isOn ? `انطفى ${style.name}` : `اشتغل ${style.name}`,
        `${next.length} من ${STYLES.length} أنماط في التناوب.`,
      ),
    ),
  );
}

async function handleList(ctx) {
  const settings = getWelcomeSettings(ctx.guildId);
  const texts = getWelcomeTexts(ctx.guildId);
  const gifs = getWelcomeGifs(ctx.guildId);
  const enabled = enabledStyles(settings);

  const lines = STYLES.map((style) => {
    const on = enabled.includes(style.key);
    const edited = Object.keys(texts[style.key] ?? {}).length;
    const marker = on ? '✅' : '⬜';
    const parts = [];

    if (edited > 0) parts.push(`${edited} معدّل`);
    if (gifs[style.key]) parts.push('GIF');
    const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';

    return `${marker} **${style.name}** — ${style.summary}${suffix}`;
  });

  const description = [
    `القناة: ${channelLabel(ctx.guild, settings.channelId)}`,
    `الوضع: ${MODE_LABELS[settings.mode] ?? settings.mode}${settings.forcedStyle ? ` (${getStyle(settings.forcedStyle)?.name ?? settings.forcedStyle})` : ''}`,
    `الروابط: القوانين ${channelLabel(ctx.guild, settings.rulesChannelId)} · العام ${channelLabel(ctx.guild, settings.generalChannelId)}`,
    '',
    `**الأنماط (${enabled.length} من ${STYLES.length} مفعّلة)**`,
    ...lines,
  ];

  if (!settings.channelId) description.unshift('⚠️ ما فيه قناة ترحيب مضبوطة.', '');

  await ctx.reply({
    embeds: [
      embed({
        title: 'بطاقات الترحيب',
        description: description.join('\n'),
        footer: 'عدّل نص أي نمط بـ /welcome edit',
      }),
    ],
  });
}

async function handleTest(ctx) {
  const settings = getWelcomeSettings(ctx.guildId);
  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);
  const styleKey = style?.key ?? chooseStyle(settings);
  const texts = getWelcomeTexts(ctx.guildId);
  const timeZone = getGuildSettings(ctx.guildId).timezone ?? config.timezone;

  const payload = buildWelcomePayload({
    guild: ctx.guild,
    member: ctx.member,
    settings,
    gifs: getWelcomeGifs(ctx.guildId),
    styleKey,
    overrides: texts[styleKey] ?? {},
    timeZone,
  });

  await ctx.reply(
    ephemeral({
      ...payload,
      content: payload.content
        ? `${RLM}${payload.content} — معاينة بطاقة **${getStyle(styleKey).name}** (ما انمنشن أحد)`
        : `معاينة بطاقة **${getStyle(styleKey).name}**.`,
    }),
  );
}

async function handleGif(ctx) {
  if (!(await requireAdmin(ctx))) return;

  let styleArg = ctx.isSlash ? ctx.getString('style') : null;
  let raw = ctx.isSlash ? (ctx.getString('url') ?? '') : '';

  if (!ctx.isSlash) {
    const first = ctx.args[1];
    const second = ctx.args[2];
    const looksLikeStyle = Boolean(resolveStyle(first));

    // `:-welcome gif <url>` still means Classic; a real style name selects that card.
    if (first && (isClearValue(first) || !looksLikeStyle)) {
      styleArg = 'classic';
      raw = first;
    } else {
      styleArg = first ?? 'classic';
      raw = second ?? '';
    }
  }

  const style = resolveStyle(styleArg ?? 'classic');

  if (!style) {
    await ctx.fail(
      ephemeral(errorReply('نمط غير معروف', `اختر واحد من: ${styleList()}.`)),
    );
    return;
  }

  const current = getWelcomeGifs(ctx.guildId)[style.key] ?? null;

  if (!String(raw).trim()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: `${style.name} · GIF`,
            description: current
              ? `${current}\n\nتشيله بـ \`/welcome gif style:${style.name} url:none\`، أو عدّله من \`/welcome edit\`.`
              : `ما فيه GIF مضبوط لـ ${style.name}. ضيفه بـ \`/welcome gif style:${style.name} url:https://media.example.com/wave.gif\`، أو عدّله من \`/welcome edit\`.`,
            image: current ?? undefined,
            color: current ? COLORS.primary : COLORS.muted,
          }),
        ],
      }),
    );
    return;
  }

  if (isClearValue(raw)) {
    setWelcomeGif(ctx.guildId, style.key, null);

    await ctx.reply(
      ephemeral(okReply(`انشال GIF ${style.name}`, 'البطاقة ما عاد فيها صورة.')),
    );
    return;
  }

  const problem = validateImageUrl(raw, 'GIF');

  if (problem) {
    await ctx.fail(ephemeral(errorReply('GIF غير صالح', problem)));
    return;
  }

  setWelcomeGif(ctx.guildId, style.key, String(raw).trim());

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `${style.name} · GIF انضبط`,
          description: `صار يظهر في بطاقة ${style.name}. عاينه بـ \`/welcome test style:${style.name}\`.`,
          image: String(raw).trim(),
          color: COLORS.success,
        }),
      ],
    }),
  );
}

async function handleEdit(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);

  if (!style) {
    await ctx.fail(
      ephemeral(errorReply('نمط غير معروف', `اختر واحد من: ${styleList()}.`)),
    );
    return;
  }

  if (!ctx.isSlash) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'استخدم أمر السلاش',
          `ديسكورد ما يفتح نماذج التعديل إلا من أوامر السلاش. شغّل \`/welcome edit style:${style.name}\`.`,
        ),
      ),
    );
    return;
  }

  const gifs = getWelcomeGifs(ctx.guildId);
  const current = styleTexts(style, getWelcomeTexts(ctx.guildId)[style.key] ?? {});
  current.gifUrl = gifs[style.key] ?? '';

  const modal = new ModalBuilder()
    .setCustomId(`welcome:edit:${style.key}`)
    .setTitle(`تعديل بطاقة ${style.name}`.slice(0, 45));

  for (const input of modalInputs(style)) {
    const field = new TextInputBuilder()
      .setCustomId(input.key)
      .setLabel(input.label.slice(0, 45))
      .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(input.max)
      .setRequired(false)
      .setValue(String(current[input.key] ?? '').slice(0, input.max));

    if (input.placeholder) field.setPlaceholder(input.placeholder);

    modal.addComponents(new ActionRowBuilder().addComponents(field));
  }

  await ctx.interaction.showModal(modal);
}

async function handleReset(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);

  if ((ctx.isSlash ? ctx.getString('style') : ctx.args[1]) && !style) {
    await ctx.fail(
      ephemeral(errorReply('نمط غير معروف', `اختر واحد من: ${styleList()}.`)),
    );
    return;
  }

  clearWelcomeTexts(ctx.guildId, style?.key ?? null);

  await ctx.reply(
    ephemeral(
      okReply(
        style ? `رجعت بطاقة ${style.name}` : 'رجعت كل نصوص الترحيب',
        style
          ? 'كل قطعة رجعت لافتراضيتها. باقي الأنماط ما انلمست.'
          : 'كل الأنماط رجعت لنصها الافتراضي.',
      ),
    ),
  );
}

async function handleLinks(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const rules = channelIdFrom(ctx, 'rules', 1);
  const general = channelIdFrom(ctx, 'general', 2);

  if (rules === undefined && general === undefined) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما فيه شي يتغيّر',
          'اذكر القنوات اللي تبي تربطها، مثل `/welcome links rules:#rules general:#general`.',
        ),
      ),
    );
    return;
  }

  const patch = {};
  if (rules !== undefined) patch.rulesChannelId = rules;
  if (general !== undefined) patch.generalChannelId = general;

  const settings = updateWelcomeSettings(ctx.guildId, patch);

  await ctx.reply(
    ephemeral(
      okReply(
        'انحدّثت روابط الترحيب',
        `القوانين: ${channelLabel(ctx.guild, settings.rulesChannelId)} · العام: ${channelLabel(ctx.guild, settings.generalChannelId)}`,
      ),
    ),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('بطاقات ترحيب للأعضاء الجدد')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('إدارة: اضبط قناة الترحيب (فاضي أو "none" يطفي البطاقات)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('وين تنكتب بطاقات الترحيب')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('mode')
        .setDescription('إدارة: اختر كيف ينختار نمط البطاقة')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('عشوائي، بالتناوب، أو نمط واحد')
            .setRequired(true)
            .addChoices(
              { name: 'عشوائي (بدون تكرار)', value: 'random' },
              { name: 'بالتناوب', value: 'rotate' },
              { name: 'نمط واحد', value: 'single' },
            ),
        )
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('النمط اللي يتثبت لما الوضع "single"')
            .setRequired(false)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('إدارة: شغّل نمط بطاقة أو اطفيه')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('النمط اللي تبي تشغّله أو تطفي')
            .setRequired(true)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('اعرض إعدادات الترحيب'))
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('عاين بطاقة، تشوفها أنت بس')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('اتركه فاضي للنمط اللي بعده في التناوب')
            .setRequired(false)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('gif')
        .setDescription('إدارة: GIF لنمط (فاضي يعرض الحالي)')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('أي بطاقة (الافتراضي كلاسيكي)')
            .setRequired(false)
            .addChoices(...styleChoices()),
        )
        .addStringOption((option) =>
          option
            .setName('url')
            .setDescription('رابط صورة/GIF مباشر، أو "none" يشيله')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('إدارة: عدّل نص نمط')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('أي نمط تبي تعدّل')
            .setRequired(true)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('إدارة: رجّع النص الافتراضي')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('رجّع نمط واحد (فاضي يرجّع الكل)')
            .setRequired(false)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('links')
        .setDescription('إدارة: القنوات اللي تستخدمها البطاقات')
        .addChannelOption((option) =>
          option
            .setName('rules')
            .setDescription('قناة القوانين، تستخدمها {rules}')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName('general')
            .setDescription('القناة العامة، تستخدمها {general}')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    ),

  name: 'welcome',
  aliases: ['greet'],
  description: 'بطاقات ترحيب للأعضاء الجدد: ستة أنماط ونصوص قابلة للتعديل',
  category: 'Community',
  usage: 'welcome <channel|mode|toggle|list|test|gif|edit|reset|links>',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    const subcommand = ctx.isSlash
      ? (ctx.getSubcommand() ?? '')
      : (ctx.args[0] ?? '').toLowerCase();

    switch (subcommand) {
      case 'channel':
        return handleChannel(ctx);
      case 'mode':
        return handleMode(ctx);
      case 'toggle':
        return handleToggle(ctx);
      case 'list':
        return handleList(ctx);
      case 'test':
        return handleTest(ctx);
      case 'gif':
        return handleGif(ctx);
      case 'edit':
        return handleEdit(ctx);
      case 'reset':
        return handleReset(ctx);
      case 'links':
        return handleLinks(ctx);
      default:
        return ctx.reply({ embeds: [overviewEmbed(ctx)] });
    }
  },

  /**
   * Modal submission for `/welcome edit`. Routed by `interactionCreate` using
   * the `welcome:edit:<style>` custom id.
   */
  async modal(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply(
        ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج صلاحية إدارة السيرفر.')),
      );
      return;
    }

    const [, action, styleKey] = interaction.customId.split(':');
    const style = action === 'edit' ? getStyle(styleKey) : null;

    if (!style) {
      await interaction.reply(
        ephemeral(errorReply('نمط غير معروف', 'هذا النمط ما عاد موجود.')),
      );
      return;
    }

    const guildId = interaction.guildId;
    const defaults = styleTexts(style, {});
    const values = {};
    const unknown = new Set();
    const problems = [];

    for (const input of modalInputs(style)) {
      const value = String(interaction.fields.getTextInputValue(input.key) ?? '').trim();
      values[input.key] = value;

      if (input.target === 'setting') {
        if (value && !isClearValue(value)) {
          const problem = validateImageUrl(value, 'GIF');
          if (problem) problems.push(`**${input.label}**: ${problem}`);
        }
      } else {
        for (const placeholder of unknownWelcomePlaceholders(value)) unknown.add(placeholder);
      }
    }

    // Validate before writing anything, so a bad GIF URL cannot half-save a card.
    if (problems.length > 0) {
      await interaction.reply(
        ephemeral(errorReply('ما انحفظ شي', problems.join('\n'))),
      );
      return;
    }

    for (const piece of style.pieces) {
      const value = values[piece.key];

      // Empty or unchanged pieces fall back to the default, so the database only
      // ever holds real edits.
      if (!value || value === defaults[piece.key]) {
        clearWelcomePiece(guildId, style.key, piece.key);
      } else {
        setWelcomePiece(guildId, style.key, piece.key, value);
      }
    }

    setWelcomeGif(guildId, style.key, !values.gifUrl || isClearValue(values.gifUrl) ? null : values.gifUrl);

    const notes = [];
    if (unknown.size > 0) {
      notes.push(
        `⚠️ متغيرات غير معروفة: ${[...unknown]
          .map((key) => `\`{${key}}\``)
          .join('، ')}. بتنطبع كنص عادي.`,
      );
    }

    // Discord parses mentions only in the description and field values.
    const unrendered = style.pieces
      .filter((piece) => piece.key === 'title' || piece.key === 'footer')
      .filter((piece) => /\{(user|rules|general)\}/.test(values[piece.key] ?? ''))
      .map((piece) => `**${piece.label}**`);

    if (unrendered.length > 0) {
      notes.push(
        `⚠️ ديسكورد ما يعرض المنشنات في ${unrendered.join(' أو ')}. \`{user}\` و\`{rules}\` و\`{general}\` بتطلع نص عادي هناك — استخدم \`{name}\` بدالها، أو انقل المنشن للوصف.`,
      );
    }

    notes.push(`عاينه بـ \`/welcome test style:${style.name}\`.`);

    await interaction.reply(
      ephemeral(okReply(`انحفظت بطاقة ${style.name}`, notes.join('\n\n'))),
    );
  },
};
