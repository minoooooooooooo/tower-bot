import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';

const log = logger;

async function collectFiles(dir) {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_')) {
      files.push(full);
    }
  }

  return files.sort();
}

async function importModule(file) {
  return import(pathToFileURL(file).href);
}

/**
 * Load every command module under `dir`.
 * Each module must default-export `{ name, execute, data?, aliases? }`.
 */
export async function loadCommands(dir) {
  const commands = new Map();
  const aliases = new Map();

  for (const file of await collectFiles(dir)) {
    const relative = path.relative(process.cwd(), file);
    let module;

    try {
      module = await importModule(file);
    } catch (error) {
      log.error(`Failed to import command ${relative}`, error);
      continue;
    }

    const command = module.default ?? module.command;

    if (!command?.name || typeof command.execute !== 'function') {
      log.warn(`Skipping ${relative}: default-export an object with "name" and "execute"`);
      continue;
    }

    if (commands.has(command.name)) {
      log.warn(`Skipping ${relative}: duplicate command name "${command.name}"`);
      continue;
    }

    commands.set(command.name, command);

    for (const alias of command.aliases ?? []) {
      if (aliases.has(alias)) {
        log.warn(`Skipping alias "${alias}" for "${command.name}": already in use`);
        continue;
      }
      aliases.set(alias, command.name);
    }

    log.debug(`Loaded command /${command.name}`);
  }

  log.info(`Loaded ${commands.size} command(s)`);

  // A real command name always beats another command's alias. Without this,
  // /top's "rank" alias would swallow `:-rank` even though /rank exists.
  for (const [alias, target] of aliases) {
    if (commands.has(alias) && target !== alias) {
      aliases.set(alias, alias);
      log.debug(`Alias "${alias}" points at its own command, not "${target}"`);
    }
  }

  return { commands, aliases };
}

/**
 * Load every event module under `dir`.
 * Each module must default-export `{ name, execute, once? }` or an array of them.
 */
export async function loadEvents(dir) {
  const events = [];

  for (const file of await collectFiles(dir)) {
    const relative = path.relative(process.cwd(), file);
    let module;

    try {
      module = await importModule(file);
    } catch (error) {
      log.error(`Failed to import event ${relative}`, error);
      continue;
    }

    const exported = module.default ?? module.event;
    const list = Array.isArray(exported) ? exported : [exported];

    for (const event of list) {
      if (!event?.name || typeof event.execute !== 'function') {
        log.warn(`Skipping ${relative}: default-export an object with "name" and "execute"`);
        continue;
      }

      events.push(event);
      log.debug(`Loaded event ${event.name}`);
    }
  }

  log.info(`Loaded ${events.length} event(s)`);
  return events;
}
