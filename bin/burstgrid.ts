#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';

const cmd = process.argv[2];

const HELP = `
Usage: burstgrid <command> [options]

Commands:
  init      Scaffold burstgrid.config.yaml from live AWS resources
  validate  Parse and validate an existing burstgrid.config.yaml

Run \`burstgrid <command> --help\` for command-specific options.
`.trim();

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}

// Remove the subcommand so each module sees only its own flags via process.argv
process.argv.splice(2, 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// tsup builds to .mjs; tsx runs .ts directly as .js
const ext = __filename.endsWith('.mjs') ? '.mjs' : '.js';

switch (cmd) {
  case 'init':
    await import(path.join(__dirname, `init${ext}`));
    break;
  case 'validate':
    await import(path.join(__dirname, `validate${ext}`));
    break;
  default:
    console.error(`Unknown command: ${cmd}\n\n${HELP}`);
    process.exit(1);
}
