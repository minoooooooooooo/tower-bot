import { logger } from '../lib/logger.js';

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
