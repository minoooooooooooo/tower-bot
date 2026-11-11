import { logger } from '../lib/logger.js';

/**
 * Discord rejects the whole bulk overwrite when a required option follows an
 * optional one, with a cryptic "options[3] ... REQUIRED_INVALID" path. Check it
 * here so the log names the command and the option instead.
 */
function optionOrderProblem(path, options = []) {
  let optionalSeen = null;

  for (const option of options) {
    if (!option.required && optionalSeen === null) optionalSeen = option.name;

    if (option.required && optionalSeen !== null) {
      return `command "${path}" requires "${option.name}" after optional "${optionalSeen}"`;
    }

    const nested = option.options
      ? optionOrderProblem(`${path} ${option.name}`, option.options)
      : null;

    if (nested) return nested;
  }

  return null;
}

export function commandPayloads(commands) {
  const payloads = [];

  for (const command of commands.values()) {
    if (!command.data) {
      logger.warn(`Command "${command.name}" has no "data", skipping slash registration`);
      continue;
    }

    const data =
      typeof command.data.toJSON === 'function' ? command.data.toJSON() : command.data;

    if (!data?.name) {
      logger.warn(`Command "${command.name}" has invalid "data", skipping slash registration`);
      continue;
    }

    const orderProblem = optionOrderProblem(data.name, data.options);

    if (orderProblem) {
      throw new Error(
        `Invalid slash command: ${orderProblem}. Required options must come before optional ones.`,
      );
    }

    payloads.push(data);
  }

  return payloads;
}

export async function registerCommands(client, commands, guildId) {
  const body = commandPayloads(commands);

  if (body.length === 0) {
    logger.warn('No slash commands to register');
    return;
  }

  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(body);
    logger.info(`Registered ${body.length} slash command(s) in "${guild.name}" (instant)`);
    return;
  }

  await client.application.commands.set(body);
  logger.info(`Registered ${body.length} global slash command(s) (up to 1 hour to propagate)`);
}
