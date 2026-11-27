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

## Replies

Use the plain-text helpers from `src/lib/replies.js` instead of building an embed:

```js
import { ephemeral, errorReply, okReply } from '../../lib/replies.js';

await ctx.reply(ephemeral(errorReply('العضو غير موجود', 'اذكر العضو أو الصق الآيدي.')));
```

- `okReply(title, body)` → `✅ **title**` plus an optional second line.
- `warnReply` and `errorReply` use ⚠️ and ❌.
- `infoReply(title, body)` (ℹ️) is for neutral output: current settings, a read-only view, a status. The moderation `_shared.js` exports `note()` for it.
- The text is Arabic. Keep it to one or two lines; join extra lines with `\n`.
- Put the useful fact first and the next step second, so a one-line phone preview still answers the question.
- Keep an embed only for list/table output (`/help`, `/store`, coin logs), where fields carry the layout.

## Confirming a destructive action

Use `askConfirmation()` from `src/lib/confirm.js` instead of refusing with "add confirm:true". It sends a second message asking the caller to type `confirm` / `تأكيد` (or `إلغاء` to cancel) in the same channel, and only then runs the closure. `messageCreate` handles the typed answer; nothing else is needed.

```js
import { askConfirmation } from '../../lib/confirm.js';
import { okReply } from '../../lib/replies.js';

async execute(ctx) {
  const run = async () => {
    // Do the destructive work here, using the same ctx. Guards that can change
    // while the prompt is open (funds, open tickets) should run again here.
    await ctx.reply(okReply('انحذف', 'انحذف العنصر.'));
  };

  await askConfirmation({
    ctx,
    prompt: 'هذا يحذف العنصر ولا ينرجع.',
    run,
  });
}
```

- The pending answer is tied to the invoking member, guild and channel, and expires after two minutes.
- Prompts are ephemeral on slash and normal replies on prefix; they are deleted once answered.
- Keep an in-command `confirm:true` (or a prefix `confirm` word) option working only as an explicit shortcut; the typed flow is the default.
- The closure may run up to two minutes later, so re-check anything that could have changed.

## Notes

- Files starting with `_` are ignored, so you can keep a template around as `_template.js`.
- The `aliases` array above is a **static prefix alias**: `:-hi` works, but `hi` alone does not. For a word that runs a command with no prefix (`مسح 100`), use the runtime `/alias` command — rows live in `command_aliases` and are read by `messageCreate`.
- Adding or removing a command requires a restart (`dev.bat` restarts automatically).
- Slash command changes are pushed on startup. Duplicate or removed commands are reconciled automatically.
- If two commands share a name or alias, the second one is skipped with a warning in the console.
