import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { ephemeral, errorReply, infoReply, okReply } from '../../lib/replies.js';
import {
  MAX_GLOSSARY_TERMS,
  MAX_MEANING_LENGTH,
  MAX_TERM_LENGTH,
  clearGlossary,
  listGlossary,
  removeGlossaryTerm,
  setGlossaryTerm,
} from '../../services/report-store.js';

const MAX_LISTED = 40;

/** `term | meaning` in one prefix argument pair. */
function parsePrefixEntry(ctx) {
  const raw = ctx.args.join(' ').trim();
  const [term, ...rest] = raw.split('|');

  return { term: term?.trim() ?? '', meaning: rest.join('|').trim() };
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تغيّر المصطلحات.')),
  );

  return false;
}

async function handleAdd(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const entry = ctx.isSlash
    ? {
        term: (ctx.getString('term') ?? '').trim(),
        meaning: (ctx.getString('meaning') ?? '').trim(),
      }
    : parsePrefixEntry(ctx);

  if (!entry.term || entry.term.length > MAX_TERM_LENGTH) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'مصطلح غير صحيح',
          `عطني مصطلح حتى ${MAX_TERM_LENGTH} حرف، وبعده المعنى مفصول بـ \`|\`.`,
        ),
      ),
    );
    return;
  }

  if (!entry.meaning || entry.meaning.length > MAX_MEANING_LENGTH) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'معنى غير صحيح',
          `اشرح المصطلح في ${MAX_MEANING_LENGTH} حرف كحد أقصى، مثل \`nap | خريطة الحدث الجديدة\`.`,
        ),
      ),
    );
    return;
  }

  if (listGlossary(ctx.guildId).length >= MAX_GLOSSARY_TERMS) {
    await ctx.fail(
      ephemeral(
        errorReply('المصطلحات مليانة', `احذف مصطلح أول (الحد ${MAX_GLOSSARY_TERMS}).`),
      ),
    );
    return;
  }

  setGlossaryTerm(ctx.guildId, entry.term, entry.meaning);

  await ctx.reply(
    ephemeral(
      okReply(
        'انحفظ المصطلح',
        `\`${entry.term}\` ← ${entry.meaning}\nالملخصات بتستخدم هذا المعنى من الحين.`,
      ),
    ),
  );
}

async function handleRemove(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const term = (ctx.isSlash ? ctx.getString('term') : ctx.args.join(' '))?.trim() ?? '';

  if (!term) {
    await ctx.fail(ephemeral(errorReply('أي مصطلح؟', 'اذكر المصطلح اللي تبي تحذفه.')));
    return;
  }

  const removed = removeGlossaryTerm(ctx.guildId, term);

  await ctx.reply(
    ephemeral(
      removed > 0
        ? okReply('انحذف المصطلح', `\`${term}\` ما عاد في قائمة المصطلحات.`)
        : infoReply('ما لقيته', `\`${term}\` ما كان في القائمة.`),
    ),
  );
}

async function handleClear(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const removed = clearGlossary(ctx.guildId);

  await ctx.reply(
    ephemeral(
      removed > 0
        ? okReply('انمسحت المصطلحات', `انحذف ${removed} مصطلح.`)
        : infoReply('فاضية أصلًا', 'ما كان فيه أي مصطلح.'),
    ),
  );
}

async function handleList(ctx) {
  const terms = listGlossary(ctx.guildId);

  if (terms.length === 0) {
    await ctx.reply(
      ephemeral(
        infoReply(
          'ما فيه مصطلحات بعد',
          'علّمني مصطلحاتكم بـ `/glossary add term:nap meaning:خريطة الحدث الجديدة`.\nالمصطلحات تساعد الملخّص يفهم السيرفر بس.',
        ),
      ),
    );
    return;
  }

  const shown = terms.slice(0, MAX_LISTED);
  const lines = shown.map((entry) => `**${entry.term}** — ${entry.meaning}`);

  if (terms.length > shown.length) lines.push(`…و ${terms.length - shown.length} غيرها`);

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `المصطلحات (${terms.length})`,
          description: lines.join('\n').slice(0, 4000),
          footer: 'تنستخدم كسياق في كل ملخص',
          color: COLORS.primary,
        }),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('glossary')
    .setDescription('علّم الملخّص مصطلحات سيرفرك')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('أضف مصطلح أو حدّثه')
        .addStringOption((option) =>
          option
            .setName('term')
            .setDescription('الكلمة أو الاختصار')
            .setRequired(true)
            .setMaxLength(MAX_TERM_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName('meaning')
            .setDescription('معناها في هذا السيرفر')
            .setRequired(true)
            .setMaxLength(MAX_MEANING_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('احذف مصطلح')
        .addStringOption((option) =>
          option.setName('term').setDescription('المصطلح اللي تبي تحذفه').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('اعرض كل المصطلحات'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('احذف كل المصطلحات')),

  name: 'glossary',
  aliases: ['jargon'],
  description: 'مصطلحات يفهمها الملخّص عن سيرفرك',
  category: 'Community',
  usage: 'glossary add <term> | <meaning> | remove <term> | list | clear',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageMessages'],

  async execute(ctx) {
    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['add', 'remove', 'delete', 'list', 'clear'].includes(ctx.args[0])
        ? ctx.args.shift()
        : 'list';

    if (sub === 'add') return handleAdd(ctx);
    if (sub === 'remove' || sub === 'delete') return handleRemove(ctx);
    if (sub === 'clear') return handleClear(ctx);

    return handleList(ctx);
  },
};
