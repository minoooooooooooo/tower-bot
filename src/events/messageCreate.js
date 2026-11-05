import { config } from '../config.js';
import { CommandContext } from '../lib/context.js';
import { createLogger } from '../lib/logger.js';
import { parseArgs } from '../lib/parse-args.js';
import { runCommand } from '../lib/run-command.js';
import { aliasAllowsChannel, getAlias } from '../services/alias-store.js';
import { runAliasCommand } from '../services/alias-runner.js';
import { recordMessage } from '../services/activity-store.js';
import { handleKeywordAlerts } from '../services/watch.js';

const logger = createLogger('prefix');

function resolvePrefix(content, client) {
  const candidates = [config.prefix, `<@${client.user.id}> `, `<@!${client.user.id}> `];
  return candidates.find((candidate) => candidate && content.startsWith(candidate)) ?? null;
}

export default {
  name: 'messageCreate',
  async execute(message, client) {
    if (!message.inGuild()) return;
    if (message.author.bot) return;

    // Activity stats count every human message, including commands. Threads are
    // folded into their parent channel so the channel leaderboard stays useful.
    if (!message.system) {
      try {
        const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;

        recordMessage({
          guildId: message.guildId,
          userId: message.author.id,
          channelId: parentId ?? message.channelId,
          at: message.createdTimestamp,
        });
      } catch (error) {
        logger.error('Activity tracking failed', error);
      }
    }

    const usedPrefix = resolvePrefix(message.content, client);

    if (!usedPrefix) {
      // A word an admin mapped to a command runs it, so "مسح 100" behaves like
      // ":-clear 100". It returns false when the message is ordinary chat
      // (unknown word, or the member could not run that command anyway).
      try {
        if (await runAliasCommand(message, client)) return;
      } catch (error) {
        logger.error('Alias dispatch failed', error);
      }

      // Every ordinary message is checked against the shared keyword list. The
      // handler swallows its own failures so a channel problem cannot break chat.
      handleKeywordAlerts(message, client).catch((error) =>
        logger.error('Keyword alert failed', error),
      );
      return;
    }

    const withoutPrefix = message.content.slice(usedPrefix.length).trim();
    if (!withoutPrefix) return;

    const [rawName, ...args] = parseArgs(withoutPrefix);
    if (!rawName) return;

    const name = rawName.toLowerCase();
    const commandName = client.aliases.get(name) ?? name;
    const command = client.commands.get(commandName);

    if (!command) {
      // `:-مسح 100` reaches the same alias the bare word does, so an explicit
      // prefix is never a dead end for a word the admin defined. The channel
      // rule applies to this path too.
      const alias = getAlias(message.guildId, name);
      if (!alias || !aliasAllowsChannel(alias, message.channel)) return;

      const target = client.commands.get(alias.command);

      if (!target || target.slashOnly) return;

      logger.debug(`${message.author.tag} used ${config.prefix}${name} (alias) -> ${target.name}`);

      const ctx = new CommandContext({ client, command: target, message, args });
      await runCommand(target, ctx);
      return;
    }

    if (command.slashOnly) return;

    logger.debug(`${message.author.tag} used ${config.prefix}${name}`);

    const ctx = new CommandContext({ client, command, message, args });
    await runCommand(command, ctx);
  },
};
