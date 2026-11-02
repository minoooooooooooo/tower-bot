# Adding a command

Every file in `src/commands/**` that exports a default object is loaded automatically. Subfolders are fine; the folder name is only organisational (use `category` to control `/help` grouping).

## Minimal slash + prefix command

```js
// src/commands/general/hello.js
import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../lib/embeds.js';

export default {
  // Slash command definition. Omit "data" for a prefix-only command.
  data: new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Say hello'),

  // Required: name used by the prefix parser and the command map.
  name: 'hello',
  aliases: ['hi'],
  description: 'Say hello',
  category: 'General',
  usage: 'hello',
  cooldown: 3, // seconds, per user

  // ctx is a CommandContext (see src/lib/context.js)
  async execute(ctx, client) {
    await ctx.reply({ embeds: [successEmbed('Hello!', `Hi ${ctx.user.username}.`)] });
  },
};
```

## Reading arguments

Slash options and prefix arguments need slightly different handling. Read the slash option first, then fall back to `ctx.args`.

```js
data: new SlashCommandBuilder()
  .setName('echo')
  .setDescription('Repeat text')
  .addStringOption((option) =>
    option.setName('text').setDescription('What to repeat').setRequired(true),
  ),

name: 'echo',
description: 'Repeat text',
category: 'General',
usage: 'echo <text>',

async execute(ctx) {
  const text = ctx.isSlash ? ctx.getString('text') : ctx.args.join(' ');
  if (!text) return ctx.reply('Give me something to say.');
  await ctx.reply(text);
}
```

Prefix arguments support quotes: `:-echo "hello world"` arrives as one argument.

## Per-command options

| Property | Type | Meaning |
|---|---|---|
| `name` | string | Command name (required) |
| `execute` | function | `(ctx, client) => Promise` (required) |
| `data` | `SlashCommandBuilder` | Enables the slash version |
| `aliases` | string[] | Extra prefix names |
| `description` | string | Shown in `/help` |
| `category` | string | `/help` grouping |
| `usage` | string | Shown in `/help <command>` |
| `cooldown` | number | Seconds per user, default `3` |
| `guildOnly` | boolean | Reject DMs |
| `ownerOnly` | boolean | Only IDs in `OWNER_IDS` |
| `permissions` | string[] | Required member permissions, e.g. `['KickMembers']` |
| `slashOnly` | boolean | Skip prefix handling |
| `autocomplete` | function | `(interaction, client) => Promise` |
| `modal` | function | `(interaction, client) => Promise`; handles modal submits whose custom id starts with `<command>:`. See `welcome.js`. |

## Context API

| Member | Description |
|---|---|
| `ctx.reply(payload)` | Reply to the interaction/message |
| `ctx.editReply(payload)` | Edit the reply (works for both styles) |
| `ctx.followUp(payload)` | Additional message |
| `ctx.send(payload)` | New message in the channel |
| `ctx.defer({ ephemeral })` | Acknowledge without visible reply (slash only) |
| `ctx.react(emoji)` | React to the prefix message |
| `ctx.args` | Prefix arguments array |
| `ctx.getString(name)` etc. | Slash option getters |
| `ctx.user`, `ctx.member`, `ctx.guild`, `ctx.channel` | Standard Discord objects |
| `ctx.isSlash`, `ctx.isPrefix` | Which style invoked it |

For an ephemeral slash reply, pass the flag explicitly:

```js
import { MessageFlags } from 'discord.js';

await ctx.reply({ content: 'Only you see this.', flags: MessageFlags.Ephemeral });
```

The prefix path strips that flag automatically, so the same code works for `:-command`.

## Notes

- Files starting with `_` are ignored, so you can keep a template around as `_template.js`.
- The `aliases` array above is a **static prefix alias**: `:-hi` works, but `hi` alone does not. For a word that runs a command with no prefix (`مسح 100`), use the runtime `/alias` command — rows live in `command_aliases` and are read by `messageCreate`.
- Adding or removing a command requires a restart (`dev.bat` restarts automatically).
- Slash command changes are pushed on startup. Duplicate or removed commands are reconciled automatically.
- If two commands share a name or alias, the second one is skipped with a warning in the console.
