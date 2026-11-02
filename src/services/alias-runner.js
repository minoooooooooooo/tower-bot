import { config } from '../config.js';
import { CommandContext } from '../lib/context.js';
import { errorEmbed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import { parseArgs } from '../lib/parse-args.js';
import { runCommand } from '../lib/run-command.js';
import { getAlias } from './alias-store.js';

const logger = createLogger('alias');

// The first word is the trigger; everything after it is the command's
// arguments, quotes included.
const FIRST_WORD = /^(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Whether a member could run this command at all. Aliases use it to stay
 * silent instead of answering "Missing permissions" in public chat every time
 * somebody happens to start a sentence with the trigger word.
 */
export function canRunAlias(command, member, userId) {
  if (command.ownerOnly && !config.ownerIds.includes(userId)) return false;

  const required = command.permissions ?? [];
  if (required.length === 0) return true;
  if (!member?.permissions) return false;

  return required.every((permission) => member.permissions.has(permission));
}

/** The alias and its command for a typed word, or null when there is none. */
export function lookupAlias(client, guildId, word) {
  const alias = getAlias(guildId, word);
  if (!alias) return null;

  return { alias, command: client.commands.get(alias.command) ?? null };
}

/**
 * Turns `مسح 100` into `clear` with `["100"]`. Returns true when the message
 * belonged to an alias, so the caller stops treating it as chat.
 */
export async function runAliasCommand(message, client) {
  const content = message.content.trim();
  if (!content) return false;

  const match = FIRST_WORD.exec(content);
  if (!match) return false;

  // A real command name always wins: if a command is added later with the same
  // word, the alias must not swallow it.
  const word = match[1].toLowerCase();
  if (client.commands.has(word) || client.aliases.has(word)) return false;

  const found = lookupAlias(client, message.guildId, match[1]);
  if (!found) return false;

  const { alias, command } = found;

  if (!command) {
    await message
      .reply({
        allowedMentions: { parse: [] },
        embeds: [
          errorEmbed(
            'Broken alias',
            `\`${alias.label}\` points to \`${alias.command}\`, which no longer exists. ` +
              `Fix it with \`${config.prefix}alias remove ${alias.label}\`.`,
          ),
        ],
      })
      .catch(() => {});
    return true;
  }

  if (command.slashOnly) {
    await message
      .reply({
        allowedMentions: { parse: [] },
        embeds: [
          errorEmbed(
            'No prefix form',
            `\`${alias.label}\` points to \`${command.name}\`, which only exists as a slash command. ` +
              `Change it with \`${config.prefix}alias add\`.`,
          ),
        ],
      })
      .catch(() => {});
    return true;
  }

  if (!canRunAlias(command, message.member, message.author.id)) return false;

  const args = match[2] ? parseArgs(match[2]) : [];
  const ctx = new CommandContext({ client, command, message, args });

  logger.debug(
    `${message.author.tag ?? message.author.username} used alias "${alias.label}" -> ${command.name}`,
  );

  await runCommand(command, ctx);
  return true;
}
