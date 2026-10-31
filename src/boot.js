// Startup entry point.
//
// Checks that the runtime can load `node:sqlite` BEFORE importing the bot,
// because a static import would fail during module linking — before any of our
// code runs — and print an unhelpful "Cannot find module" error.
//
// Keep using this file as the entry point on hosting panels, where the Node
// version is out of our control.

import { sqliteUnavailableMessage } from './lib/runtime.js';
import { createLogger } from './lib/logger.js';

const logger = createLogger('boot');

async function main() {
  try {
    await import('node:sqlite');
  } catch {
    console.error(sqliteUnavailableMessage());
    process.exit(1);
  }

  logger.info(`Runtime Node ${process.versions.node}`);

  await import('./index.js');
}

main().catch((error) => {
  console.error('\n[boot] Failed to start the bot:\n');
  console.error(error);
  process.exit(1);
});
