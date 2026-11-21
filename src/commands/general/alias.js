import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { errorReply, okReply, warnReply } from '../../lib/replies.js';
import { resolveChannel } from '../../lib/resolve.js';
import {
  MAX_ALIASES,
  MAX_TRIGGER_LENGTH,
  addAliasChannel,
  clearAliasChannels,
  countAliases,
  getAlias,
  listAliases,
  normalizeTrigger,
  removeAlias,
  removeAliasChannel,
  saveAlias,
} from '../../services/alias-store.js';

// Letters, marks (Arabic diacritics), digits, underscore and dash. Anything
// else (mentions, punctuation, emoji) would make matching ambiguous or hijack
// messages in odd ways.
const TRIGGER_PATTERN = /^[\p{L}\p{M}\p{N}_-]+$/u;

// Words that start a huge share of ordinary sentences. An alias on one of
// these runs the command on messages that were never meant as commands, so the
// admin gets a warning instead of surprise moderation.
const COMMON_WORDS = new Set(
  [
    'من', 'في', 'على', 'الي', 'عن', 'مع', 'هذا', 'هذه', 'هو', 'هي', 'لا', 'نعم',
    'ما', 'ان', 'انه', 'كان', 'يا', 'او', 'كل', 'بس', 'شو', 'ليش', 'كيف', 'وين',
    'متى', 'انا', 'انت', 'انتي', 'احنا', 'هم', 'لازم', 'بدي', 'ابي', 'اريد',
    'the', 'a', 'an', 'to', 'is', 'are', 'i', 'we', 'you',
  ].map(normalizeTrigger),
);

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تغيّر الأسماء البديلة.')),
  );

  return false;
}

function cleanCommandInput(value) {
  let text = String(value ?? '').trim();

  if (config.prefix && text.startsWith(config.prefix)) {
    text = text.slice(config.prefix.length);
  }

  if (text.startsWith('/') || text.startsWith('!')) text = text.slice(1);

  return text.trim().toLowerCase();
}

/** `مسح` is valid; `مسح 100`, `@here` and a 40-character word are not. */
function validateTrigger(value, client) {
  const label = String(value ?? '').trim();

  if (!label) {
    return { error: 'اكتب الكلمة اللي تبي تنطقها، مثل `مسح`.' };
  }

  if (label.length > MAX_TRIGGER_LENGTH) {
    return { error: `خلّ الكلمة أقل من ${MAX_TRIGGER_LENGTH} حرف.` };
  }

  if (/\s/.test(label)) {
    return { error: 'الاسم البديل كلمة وحدة — وكل اللي بعدها يصير وسائط الأمر.' };
  }

  if (!TRIGGER_PATTERN.test(label)) {
    return { error: 'حروف وأرقام و`_` و`-` بس — بدون إيموجي أو منشن أو علامات ترقيم.' };
  }

  const name = label.toLowerCase();

  if (client.commands.has(name) || client.aliases.has(name)) {
    return {
      error: `\`${label}\` اسم أمر أصلًا. شغّله كـ \`${config.prefix}${label}\` بدال.`,
    };
  }

  return { label };
}

function resolveCommand(client, value) {
  const name = cleanCommandInput(value);
  if (!name) return null;

  return client.commands.get(client.aliases.get(name) ?? name) ?? null;
}

/** `clear <amount> [user]` becomes `مسح <amount> [user]`. */
function usageFor(alias, command) {
  const usage = command.usage ?? command.name;
  const rest = usage.startsWith(command.name) ? usage.slice(command.name.length) : usage;
  return `${alias}${rest}`.replace(/\s+/g, ' ').trim();
}

function channelName(guild, channelId) {
  const channel = guild?.channels?.cache?.get?.(channelId);
  return channel?.name ? `#${channel.name}` : `\`${channelId}\``;
}

/** "only #general, #bot-spam" / "everywhere except #general". */
function ruleSummary(alias, guild) {
  if (!alias?.channelMode || !alias.channels?.length) return 'في كل القنوات';

  const names = alias.channels.map((id) => channelName(guild, id)).join('، ');
  return alias.channelMode === 'allow' ? `فقط في ${names}` : `في كل القنوات إلا ${names}`;
}

function describeAdd({ alias, command, updated }) {
  const lines = [
    `الحين كتابة **${alias.label}** تشغّل \`${command.name}\`.`,
    `الاستخدام: \`${usageFor(alias.label, command)}\``,
    `بس الأعضاء اللي يقدرون يستخدمون \`${command.name}\` بيشغّلونه — غيرهم ينطبق عليه السكوت.`,
  ];

  if (COMMON_WORDS.has(normalizeTrigger(alias.label))) {
    const text = lines.join('\n');

    return warnReply(
      updated ? 'تم تحديث الاسم البديل' : 'تم حفظ الاسم البديل',
      `${text}\n\n⚠️ **${alias.label}** كلمة شائعة جدًا، فأي رسالة تبدأ بها تشغّل الأمر. كلمة أغرب أأمن.`,
    );
  }

  return okReply(updated ? 'تم تحديث الاسم البديل' : 'تم حفظ الاسم البديل', lines.join('\n'));
}

async function handleAdd(ctx, client) {
  if (!(await requireManageGuild(ctx))) return;

  const triggerInput = ctx.isSlash ? ctx.getString('trigger') : ctx.args[1];
  const commandInput = ctx.isSlash ? ctx.getString('command') : ctx.args[2];

  if (!ctx.isSlash && ctx.args.length > 3) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'كلمة وحدة بس',
          `الاستخدام: \`${config.prefix}alias add <word> <command>\` — مثل \`${config.prefix}alias add مسح clear\`.`,
        ),
      ),
    );
    return;
  }

  const trigger = validateTrigger(triggerInput, client);

  if (trigger.error) {
    await ctx.fail(ephemeral(errorReply('كلمة غير صحيحة', trigger.error)));
    return;
  }

  const command = resolveCommand(client, commandInput);

  if (!command) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'أمر غير معروف',
          commandInput
            ? `ما فيه أمر اسمه \`${cleanCommandInput(commandInput)}\`. شغّل \`${config.prefix}help\` عشان تشوف الكل.`
            : `حدّد الأمر اللي ينشغّل، مثل \`${config.prefix}alias add ${trigger.label} clear\`.`,
        ),
      ),
    );
    return;
  }

  if (command.slashOnly) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما له صيغة بادئة',
          `\`${command.name}\` موجود كأمر سلاش بس، فما ينفع ينشغّل بكلمة.`,
        ),
      ),
    );
    return;
  }

  if (command.name === 'alias') {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما مسموح',
          'الاسم البديل ما يقدر يشير لأمر الأسماء البديلة نفسه. اختر الأمر اللي تبي تختصره فعلًا.',
        ),
      ),
    );
    return;
  }

  const existing = getAlias(ctx.guildId, trigger.label);

  if (!existing && countAliases(ctx.guildId) >= MAX_ALIASES) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'أسماء بديلة كثيرة',
          `السيرفر عنده ${MAX_ALIASES} من قبل. احذف واحد بـ \`${config.prefix}alias remove <word>\` أول.`,
        ),
      ),
    );
    return;
  }

  const alias = saveAlias({
    guildId: ctx.guildId,
    trigger: trigger.label,
    label: trigger.label,
    command: command.name,
    createdBy: ctx.user.id,
  });

  await ctx.reply(ephemeral(describeAdd({ alias, command, updated: Boolean(existing) })));
}

async function handleRemove(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const triggerInput = ctx.isSlash ? ctx.getString('trigger') : ctx.args[1];
  const alias = getAlias(ctx.guildId, triggerInput);

  if (!alias) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما فيه اسم بديل',
          triggerInput
            ? `ما فيه شي مربوط بـ \`${triggerInput}\`. شوف الكل بـ \`${config.prefix}alias list\`.`
            : `حدّد الكلمة اللي تبي تحذفها، مثل \`${config.prefix}alias remove مسح\`.`,
        ),
      ),
    );
    return;
  }

  removeAlias(ctx.guildId, alias.trigger);

  await ctx.reply(
    ephemeral(
      okReply(
        'انحذف الاسم البديل',
        `**${alias.label}** ما عاد يشغّل \`${alias.command}\`. الأمر نفسه لسا يشتغل كـ \`${config.prefix}${alias.command}\`.`,
      ),
    ),
  );
}

async function handleChannel(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const triggerInput = ctx.isSlash ? ctx.getString('trigger') : ctx.args[1];
  const alias = getAlias(ctx.guildId, triggerInput);

  if (!alias) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما فيه اسم بديل',
          triggerInput
            ? `ما فيه شي مربوط بـ \`${triggerInput}\`. أنشئه بـ \`${config.prefix}alias add ${triggerInput} clear\`.`
            : `حدّد الاسم البديل اللي تبي تقيّده، مثل \`${config.prefix}alias channel مسح allow #general\`.`,
        ),
      ),
    );
    return;
  }

  const action = String(
    (ctx.isSlash ? ctx.getString('action') : ctx.args[2]) ?? 'list',
  ).toLowerCase();

  if (action === 'list' || action === 'show') {
    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: `قنوات الاسم البديل · ${alias.label}`,
            description: [
              `**${alias.label}** يشتغل ${ruleSummary(alias, ctx.guild)}.`,
              '',
              `\`${config.prefix}alias channel ${alias.label} allow #channel\` — هذي القناة بس (أضف غيرها لتوسيع القائمة)`,
              `\`${config.prefix}alias channel ${alias.label} deny #channel\` — كل القنوات إلا هذي`,
              `\`${config.prefix}alias channel ${alias.label} remove #channel\` — شيل قناة وحدة`,
              `\`${config.prefix}alias channel ${alias.label} clear\` — امسح كل القواعد`,
            ].join('\n'),
            footer: 'الثريدات تتبع قناتها الأم، والقنوات تتبع تصنيفها',
          }),
        ],
      }),
    );
    return;
  }

  if (action === 'clear' || action === 'everywhere' || action === 'reset') {
    clearAliasChannels(ctx.guildId, alias.trigger);

    await ctx.reply(
      ephemeral(
        okReply('انمسحت قنوات الاسم البديل', `**${alias.label}** رجع يشتغل في كل القنوات.`),
      ),
    );
    return;
  }

  if (!['allow', 'deny', 'remove'].includes(action)) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'إجراء غير معروف',
          `استخدم \`allow\` أو \`deny\` أو \`remove\` أو \`clear\` أو \`list\`.\n` +
            `مثال: \`${config.prefix}alias channel ${alias.label} allow #general\`.`,
        ),
      ),
    );
    return;
  }

  const channelInput = ctx.isSlash ? ctx.getChannel('channel') : ctx.args[3];
  const channel = ctx.isSlash
    ? channelInput
    : await resolveChannel(ctx.guild, channelInput);

  if (!channel) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'اختر قناة',
          `منشن القناة، مثل \`${config.prefix}alias channel ${alias.label} ${action} #general\`.`,
        ),
      ),
    );
    return;
  }

  if (action === 'remove') {
    const updated = removeAliasChannel({
      guildId: ctx.guildId,
      trigger: alias.trigger,
      channelId: channel.id,
    });

    if (!updated) {
      await ctx.fail(ephemeral(errorReply('ما فيه اسم بديل', 'الاسم البديل اختفى أثناء التعديل.')));
      return;
    }

    await ctx.reply(
      ephemeral(
        okReply(
          'انشالت القناة',
          updated.channelMode
            ? `**${alias.label}** ما عاد يشمل ${channelName(ctx.guild, channel.id)}. الحين يشتغل ${ruleSummary(updated, ctx.guild)}.`
            : `**${alias.label}** ما عاد يشمل ${channelName(ctx.guild, channel.id)} ورجع يشتغل في كل القنوات.`,
        ),
      ),
    );
    return;
  }

  const beforeMode = alias.channelMode;
  const updated = addAliasChannel({
    guildId: ctx.guildId,
    trigger: alias.trigger,
    channelId: channel.id,
    mode: action,
  });

  if (!updated) {
    await ctx.fail(ephemeral(errorReply('ما فيه اسم بديل', 'الاسم البديل اختفى أثناء التعديل.')));
    return;
  }

  const switched = beforeMode && beforeMode !== action;
  const lines = [`**${alias.label}** الحين يشتغل ${ruleSummary(updated, ctx.guild)}.`];

  if (switched) {
    lines.push(
      '',
      `قائمة **${beforeMode === 'allow' ? 'السماح' : 'المنع'}** القديمة انمسحت لما تحوّلت القاعدة إلى **${action === 'allow' ? 'السماح' : 'المنع'}**.`,
    );
  }

  lines.push('', 'الثريدات تتبع قناتها الأم، والقنوات تتبع تصنيفها.');

  await ctx.reply(ephemeral(okReply('تحدّثت قنوات الاسم البديل', lines.join('\n'))));
}

async function handleList(ctx) {
  const aliases = listAliases(ctx.guildId);
  const commands = ctx.client.commands;

  if (aliases.length === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: 'ما فيه أسماء بديلة بعد',
            description: [
              'الاسم البديل يخليك تشغّل أمر بكلمة تكتبها، بدون بادئة.',
              `مثال: \`${config.prefix}alias add مسح clear\` — بعدها \`مسح 100\` يحذف 100 رسالة.`,
            ].join('\n'),
            color: COLORS.muted,
          }),
        ],
      }),
    );
    return;
  }

  const lines = aliases.map((alias) => {
    const command = commands.get(alias.command);
    const usage = command ? usageFor(alias.label, command) : `${alias.label} …`;
    const broken = command ? '' : ' *(معطّل — الأمر مو موجود)*';
    const rule =
      alias.channelMode && alias.channels.length
        ? ` · ${ruleSummary(alias, ctx.guild)}`
        : '';
    return `**${alias.label}** ← \`${alias.command}\`${broken}${rule}\n\`${usage}\``;
  });

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: 'الأسماء البديلة',
          description: lines.join('\n\n'),
          footer: `${aliases.length} من ${MAX_ALIASES} · ${config.prefix}alias add <word> <command>`,
        }),
      ],
    }),
  );
}

function usageEmbed() {
  return embed({
    title: 'الأسماء البديلة',
    description: [
      `اكتب كلمة بدال الأمر، فـ \`مسح 100\` يشتغل مثل \`${config.prefix}clear 100\`.`,
      '',
      `\`${config.prefix}alias add مسح clear\` — أنشئ واحد أو غيّره`,
      `\`${config.prefix}alias remove مسح\` — احذف واحد`,
      `\`${config.prefix}alias channel مسح allow #general\` — في هذي القناة بس`,
      `\`${config.prefix}alias channel مسح deny #off-topic\` — كل القنوات إلا هذي`,
      `\`${config.prefix}alias channel مسح clear\` — يرجع يشتغل في كل القنوات`,
      `\`${config.prefix}alias list\` — اعرض الكل`,
      '',
      'وكل اللي بعد الكلمة ينرسل للأمر كوسائط.',
    ].join('\n'),
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('alias')
    .setDescription('شغّل أمر بكلمة تكتبها، بدون بادئة')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('أنشئ أو غيّر كلمة تشغّل أمر')
        .addStringOption((option) =>
          option
            .setName('trigger')
            .setDescription('الكلمة اللي تنكتب، مثل مسح')
            .setRequired(true)
            .setMaxLength(MAX_TRIGGER_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('الأمر اللي ينشغّل، مثل clear')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('احذف اسمًا بديلًا')
        .addStringOption((option) =>
          option
            .setName('trigger')
            .setDescription('الكلمة اللي تبي توقفها')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('اعرض كل الأسماء البديلة'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('channel')
        .setDescription('اختر القنوات اللي يشتغل فيها الاسم البديل')
        .addStringOption((option) =>
          option
            .setName('trigger')
            .setDescription('الكلمة اللي تبي تقيّدها')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('اسمح بقناة، امنعها، اشيلها، امسح القواعد، أو اعرضها (الافتراضي: عرض)')
            .setRequired(false)
            .addChoices(
              { name: 'اسمح بقناة', value: 'allow' },
              { name: 'امنع قناة', value: 'deny' },
              { name: 'شيل قناة', value: 'remove' },
              { name: 'امسح كل القواعد', value: 'clear' },
              { name: 'اعرض القواعد', value: 'list' },
            ),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('قناة أو تصنيف أو ثريد (ما يلزم للعرض والمسح)')
            .setRequired(false),
        ),
    ),

  name: 'alias',
  aliases: ['aliases', 'shortcut', 'shortcuts'],
  description: 'شغّل أمر بكلمة تكتبها، بدون بادئة',
  category: 'General',
  usage:
    'alias add <word> <command> | remove <word> | channel <word> <allow|deny|remove|clear|list> [#channel] | list',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'command') {
      const query = cleanCommandInput(focused.value);
      const matches = [...client.commands.values()]
        .filter(
          (command) =>
            command.name !== 'alias' && !command.slashOnly && command.name.includes(query),
        )
        .slice(0, 25)
        .map((command) => ({ name: `/${command.name}`, value: command.name }));

      await interaction.respond(matches);
      return;
    }

    const query = normalizeTrigger(focused.value);
    const matches = listAliases(interaction.guildId)
      .filter((alias) => !query || alias.trigger.includes(query))
      .slice(0, 25)
      .map((alias) => ({ name: `${alias.label} → ${alias.command}`, value: alias.label }));

    await interaction.respond(matches);
  },

  async execute(ctx, client) {
    const subcommand = (ctx.isSlash ? ctx.getSubcommand() : ctx.args[0])?.toLowerCase();

    if (subcommand === 'add') return handleAdd(ctx, client);
    if (subcommand === 'remove' || subcommand === 'delete') return handleRemove(ctx);
    if (subcommand === 'channel' || subcommand === 'channels') return handleChannel(ctx);
    if (subcommand === 'list' || subcommand === 'show') return handleList(ctx);

    await ctx.reply(ephemeral({ embeds: [usageEmbed()] }));
  },
};
