import { registerCommands } from './commands.js';

registerCommands().catch(error => {
  console.error('Error registering commands:', error);
  process.exit(1);
});
