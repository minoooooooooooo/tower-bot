import { config } from '../config.js';
import { CommandContext } from '../lib/context.js';
import { createLogger } from '../lib/logger.js';
import { runCommand } from '../lib/run-command.js';

const logger = createLogger('prefix');

function parseArgs(content) {
  const args = [];
  let current = '';
  let quote = null;

  for (const char of content) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);

  return args;
}

function resolvePrefix(content, client) {
  const candidates = [config.prefix, `<@${client.user.id}> `, `<@!${client.user.id}> `];
  return candidates.find((candidate) => candidate && content.startsWith(candidate)) ?? null;
}

export default {
  name: 'messageCreate',
  async execute(message, client) {
    if (!message.inGuild()) return;
    if (message.author.bot) return;

    const usedPrefix = resolvePrefix(message.content, client);
    if (!usedPrefix) return;

    const withoutPrefix = message.content.slice(usedPrefix.length).trim();
    if (!withoutPrefix) return;

    const [rawName, ...args] = parseArgs(withoutPrefix);
    if (!rawName) return;

    const name = rawName.toLowerCase();
    const commandName = client.aliases.get(name) ?? name;
    const command = client.commands.get(commandName);

    if (!command) return;
    if (command.slashOnly) return;

    logger.debug(`${message.author.tag} used ${config.prefix}${name}`);

    const ctx = new CommandContext({ client, command, message, args });
    await runCommand(command, ctx);
  },
};
