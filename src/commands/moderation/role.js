import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { findRoleMatches, parseReference, resolveMember, resolveRole } from '../../lib/resolve.js';

const logger = createLogger('role');

// A bulk run makes one API call per member. The cap keeps a giant server from
// holding the interaction open until it expires; the summary says when it bites.
const BULK_LIMIT = 500;

const ACTION_LABELS = { add: 'Added', remove: 'Removed', toggle: 'Toggled' };
const ACTION_WORDS = { add: 'add', '+': 'add', remove: 'remove', '-': 'remove', toggle: 'toggle' };
const TARGET_WORDS = { all: 'humans', humans: 'humans', bots: 'bots' };

const USAGE = {
  slash: [
    '/role toggle role:@Role [user:@member]',
    '/role add role:@Role [user:@member]',
    '/role remove role:@Role [user:@member]',
    '/role bulk action:add role:@Role target:humans',
  ],
  prefix: [
    ':-role @Role            toggle it on yourself',
    ':-role +@Role           add it to yourself',
    ':-role -@Role           remove it from yourself',
    ':-role @member +@Role   add it to one member',
    ':-role all +@Role       add it to every human member',
    ':-role bots -@Role      remove it from every bot',
  ],
};

function ephemeral(payload) {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function reasonFor(ctx) {
  return `Role command: ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500);
}

function usageLines(ctx) {
  const examples = ctx.isSlash ? USAGE.slash : USAGE.prefix;
  return ['**Usage:**', ...examples.map((line) => `\`${line}\``)].join('\n');
}

function fail(ctx, title, description) {
  return ctx.fail(ephemeral({ embeds: [errorEmbed(title, description)] }));
}

function respond(ctx, payload) {
  const body = { ...payload, allowedMentions: { parse: [] } };

  if (ctx.isSlash) return ctx.editReply(body);
  return ctx.reply(body);
}

function apiProblem(error) {
  if (error?.code === 50013) {
    return 'Discord says I do not have permission. Check **Manage Roles** and that my highest role sits above the target and the role.';
  }

  if (error?.code === 50035) {
    return 'Discord rejected the request as invalid. Double-check the role and the member.';
  }

  if (error?.code === 429 || /rate limit/i.test(String(error?.message))) {
    return 'Discord is rate limiting role changes. Wait a minute and try again.';
  }

  return error?.message
    ? `Discord said: ${String(error.message).slice(0, 300)}`
    : 'Something went wrong while changing the role.';
}

function botProblem(guild) {
  const me = guild.members?.me;

  if (!me) return 'I could not read my own server profile. Try again in a moment.';

  if (!me.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return 'I need the **Manage Roles** permission to change roles.';
  }

  return null;
}

/** Refuses roles Discord will not let a bot assign by hand. */
function roleProblem(guild, role) {
  if (!role) {
    return 'Pick a role — mention it (`@Role`), paste its id, or type its exact name.';
  }

  if (role.id === guild.id) {
    return 'The **@everyone** role cannot be added or removed.';
  }

  if (role.managed) {
    return `**${role.name}** is managed by an integration and cannot be assigned by hand.`;
  }

  const botTop = guild.members?.me?.roles?.highest?.position ?? 0;

  if ((role.position ?? 0) >= botTop) {
    return `My highest role must sit **above ${role.name}**. Drag my role up in **Server Settings → Roles**, then try again.`;
  }

  return null;
}

/** Refuses members the bot cannot outrank. Managing its own roles is allowed. */
function memberProblem(member, me) {
  if (!member) return 'Pick a member of this server.';
  if (!me) return 'I could not read my own server profile. Try again in a moment.';
  if (member.id === me.id) return null;

  const botTop = me.roles?.highest?.position ?? 0;
  const memberTop = member.roles?.highest?.position ?? 0;

  if (memberTop >= botTop) {
    const name = member.displayName ?? member.user?.username ?? 'That member';
    return `**${name}** sits at or above my highest role, so I cannot change their roles. Move my role higher first.`;
  }

  return null;
}

/**
 * Adds, removes or toggles one role. Returns `added`, `removed` or `unchanged`
 * so a bulk run can report exactly what happened.
 */
async function applyRole(member, role, action, reason) {
  const has = member.roles?.cache?.has(role.id) ?? false;
  const shouldHave = action === 'toggle' ? !has : action === 'add';

  if (shouldHave === has) return 'unchanged';

  if (shouldHave) await member.roles.add(role, reason);
  else await member.roles.remove(role, reason);

  return shouldHave ? 'added' : 'removed';
}

function parseAction(tokens) {
  if (tokens.length === 0) return { action: 'toggle', tokens };

  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const isMarker = (token) => token === '+' || token === '-';

  // `:-role + @Role` / `:-role @Role +`
  if (isMarker(first)) {
    return { action: first === '+' ? 'add' : 'remove', tokens: tokens.slice(1) };
  }

  if (tokens.length > 1 && isMarker(last)) {
    return { action: last === '+' ? 'add' : 'remove', tokens: tokens.slice(0, -1) };
  }

  // `:-role +@Role` / `:-role -@Role`
  if (first.length > 1 && (first[0] === '+' || first[0] === '-')) {
    return {
      action: first[0] === '+' ? 'add' : 'remove',
      tokens: [first.slice(1), ...tokens.slice(1)],
    };
  }

  // `:-role add @Role`
  const word = ACTION_WORDS[String(first).toLowerCase()];

  if (tokens.length > 1 && word) {
    return { action: word, tokens: tokens.slice(1) };
  }

  return { action: 'toggle', tokens };
}

async function prefixPlan(ctx) {
  const args = [...ctx.args];
  let target = { kind: 'self' };

  const first = String(args[0] ?? '').toLowerCase();

  if (TARGET_WORDS[first]) {
    target = { kind: TARGET_WORDS[first] };
    args.shift();
  }

  // A mention or id in front of the role targets one member. A role id is left
  // alone so `:-role 123456789012345678` still toggles that role on yourself.
  if (args.length > 1) {
    const ref = parseReference(args[0]);
    const looksLikeMember =
      ref &&
      (ref.kind === 'user' ||
        (ref.kind === 'id' && !ctx.guild.roles?.cache?.has?.(ref.id)));

    if (looksLikeMember) {
      const member = await resolveMember(ctx.guild, args[0], ctx.message);

      if (member) {
        target = { kind: 'member', member };
        args.shift();
      }
    }
  }

  const { action, tokens } = parseAction(args);

  return { target, action, text: tokens.join(' ').trim() };
}

async function collectMembers(guild, kind) {
  const cache = guild.members?.cache;
  let members = [];

  if ((cache?.size ?? 0) > 0 && cache.size >= (guild.memberCount ?? 0)) {
    members = [...cache.values()];
  } else {
    try {
      const fetched = await guild.members.fetch();
      members = [...fetched.values()];
    } catch {
      members = [...(cache?.values?.() ?? [])];
    }
  }

  return members
    .filter((member) => (kind === 'bots' ? member.user?.bot : !member.user?.bot))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function runSingle(ctx, member, role, action) {
  const me = ctx.guild.members?.me;
  const problem = memberProblem(member, me);

  if (problem) {
    await fail(ctx, 'Cannot change that member', problem);
    return;
  }

  await ctx.defer({ ephemeral: true });

  try {
    const result = await applyRole(member, role, action, reasonFor(ctx));
    const who = member.id === ctx.user.id ? 'you' : `${member}`;

    const description =
      result === 'added'
        ? `Added ${role} to ${who}.`
        : result === 'removed'
          ? `Removed ${role} from ${who}.`
          : action === 'add'
            ? `${role} is already on ${who}.`
            : `${role} is not on ${who}.`;

    const title =
      result === 'unchanged'
        ? 'Nothing to change'
        : result === 'added'
          ? 'Role added'
          : 'Role removed';

    await respond(ctx, {
      embeds: [
        embed({
          title,
          description,
          color: result === 'unchanged' ? COLORS.muted : COLORS.success,
        }),
      ],
    });
  } catch (error) {
    logger.warn(`Role change failed for ${member.id} on ${role.id}: ${error.message}`);
    await fail(ctx, 'Could not change the role', apiProblem(error));
  }
}

async function runBulk(ctx, target, role, action) {
  await ctx.defer({ ephemeral: true });

  const members = await collectMembers(ctx.guild, target);
  const me = ctx.guild.members?.me;
  const counts = { added: 0, removed: 0, unchanged: 0, skipped: 0, failed: 0 };
  let firstFailure = null;

  for (const member of members.slice(0, BULK_LIMIT)) {
    if (memberProblem(member, me)) {
      counts.skipped += 1;
      continue;
    }

    try {
      const result = await applyRole(member, role, action, reasonFor(ctx));
      counts[result] += 1;
    } catch (error) {
      counts.failed += 1;
      firstFailure ??= `${member}: ${apiProblem(error)}`;
    }
  }

  const audience = target === 'bots' ? 'bots' : 'human members';
  const lines = [
    `${role} — **${ACTION_LABELS[action].toLowerCase()}** for ${audience}.`,
    '',
    `**Added:** ${counts.added}`,
    `**Removed:** ${counts.removed}`,
    `**Already correct:** ${counts.unchanged}`,
    `**Skipped:** ${counts.skipped}${counts.skipped ? ' (higher than my role)' : ''}`,
  ];

  if (counts.failed) {
    lines.push(`**Failed:** ${counts.failed}`);
    if (firstFailure) lines.push(`> ${firstFailure}`);
  }

  if (members.length > BULK_LIMIT) {
    lines.push(
      '',
      `Only the first **${BULK_LIMIT}** members were processed — run it again for the rest.`,
    );
  }

  logger.info(
    `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) ${action} ${role.name} (${role.id}) for ${members.length} ${audience}: +${counts.added} -${counts.removed} =${counts.unchanged} skip${counts.skipped} fail${counts.failed}`,
  );

  await respond(ctx, {
    embeds: [
      embed({
        title: `Bulk ${action}: ${role.name}`,
        description: lines.join('\n'),
        color: counts.failed ? COLORS.warning : COLORS.success,
      }),
    ],
  });
}

/** Escapes the typed word so bold/italic characters cannot break the reply. */
function display(text) {
  return String(text ?? '').replace(/([\\`*_~|>])/g, '\\$1');
}

function ambiguousRoleDescription(text, matches) {
  const shown = matches.slice(0, 10);
  const lines = shown.map((role) => `• **${role.name}**`);

  if (matches.length > shown.length) {
    lines.push(`…and **${matches.length - shown.length}** more.`);
  }

  return [
    `**${display(text)}** matches **${matches.length}** roles:`,
    ...lines,
    '',
    'Type more of the name, or mention the role.',
  ].join('\n');
}

async function executePrefix(ctx) {
  if (ctx.args.length === 0) {
    await ctx.reply(
      ephemeral({ embeds: [embed({ title: 'Role command', description: usageLines(ctx) })] }),
    );
    return;
  }

  const { target, action, text } = await prefixPlan(ctx);

  if (!text) {
    await fail(ctx, 'Which role?', `Give one role.\n\n${usageLines(ctx)}`);
    return;
  }

  // Mentions and ids are exact by nature. A plain word is searched: exact name
  // first, then names that start with or contain it, so "سكان" finds
  // "سكان البرج" but "رون" refuses when it fits several roles.
  const ref = parseReference(text);
  const matches = ref ? [] : findRoleMatches(ctx.guild, text);
  let role = null;

  if (ref) {
    role = await resolveRole(ctx.guild, text).catch(() => null);
  } else if (matches.length === 1) {
    role = matches[0];
  }

  if (!role) {
    if (matches.length > 1) {
      await fail(ctx, 'Ambiguous role', ambiguousRoleDescription(text, matches));
      return;
    }

    await fail(
      ctx,
      'Unknown role',
      ref
        ? 'Pick a role — mention it (`@Role`), paste its id, or type its exact name.'
        : `No role name contains **${display(text)}**. Check the spelling, mention the role, or paste its id.`,
    );
    return;
  }

  const problem = roleProblem(ctx.guild, role);

  if (problem) {
    await fail(ctx, 'Cannot use that role', problem);
    return;
  }

  if (target.kind === 'humans' || target.kind === 'bots') {
    await runBulk(ctx, target.kind, role, action);
    return;
  }

  const member = target.kind === 'member' ? target.member : ctx.member;

  if (!member) {
    await fail(ctx, 'Unknown member', 'Mention someone in this server, or paste their id.');
    return;
  }

  await runSingle(ctx, member, role, action);
}

async function executeSlash(ctx) {
  const sub = ctx.getSubcommand() ?? 'toggle';

  if (sub === 'bulk') {
    const role = ctx.getRole('role');
    const problem = roleProblem(ctx.guild, role);

    if (problem) {
      await fail(ctx, role ? 'Cannot use that role' : 'Unknown role', problem);
      return;
    }

    const action = ctx.getString('action') ?? 'toggle';
    const target = ctx.getString('target') ?? 'humans';

    await runBulk(ctx, target, role, action);
    return;
  }

  const action = ['add', 'remove', 'toggle'].includes(sub) ? sub : 'toggle';
  const role = ctx.getRole('role');
  const problem = roleProblem(ctx.guild, role);

  if (problem) {
    await fail(ctx, role ? 'Cannot use that role' : 'Unknown role', problem);
    return;
  }

  const user = ctx.getUser('user');
  const member = user
    ? (ctx.getMember('user') ??
      (await ctx.guild.members.fetch(user.id).catch(() => null)))
    : ctx.member;

  if (!member) {
    await fail(ctx, 'Unknown member', 'Mention someone in this server, or paste their id.');
    return;
  }

  await runSingle(ctx, member, role, action);
}

export default {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Add, remove or toggle a role for yourself, a member, or everyone')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Toggle the role: add it when missing, remove it when present')
        .addRoleOption((option) =>
          option.setName('role').setDescription('The role to toggle').setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Member to change (defaults to you)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add the role when the member does not have it')
        .addRoleOption((option) =>
          option.setName('role').setDescription('The role to add').setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Member to change (defaults to you)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove the role when the member has it')
        .addRoleOption((option) =>
          option.setName('role').setDescription('The role to remove').setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Member to change (defaults to you)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('bulk')
        .setDescription('Apply a role to every human member or every bot')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('What to do with the role')
            .setRequired(true)
            .addChoices(
              { name: 'Add', value: 'add' },
              { name: 'Remove', value: 'remove' },
              { name: 'Toggle', value: 'toggle' },
            ),
        )
        .addRoleOption((option) =>
          option.setName('role').setDescription('The role to change').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('Who to change')
            .setRequired(true)
            .addChoices(
              { name: 'Humans', value: 'humans' },
              { name: 'Bots', value: 'bots' },
            ),
        ),
    ),

  name: 'role',
  aliases: ['roles'],
  description: 'Add, remove or toggle a role (Manage Roles)',
  category: 'Moderation',
  usage: 'role [all|bots] [@member] [+|-]<@role>',
  cooldown: 10,
  guildOnly: true,
  permissions: ['ManageRoles'],

  async execute(ctx) {
    const problem = botProblem(ctx.guild);

    if (problem) {
      await fail(ctx, 'Missing permissions', problem);
      return;
    }

    if (ctx.isSlash) return executeSlash(ctx);
    return executePrefix(ctx);
  },
};
