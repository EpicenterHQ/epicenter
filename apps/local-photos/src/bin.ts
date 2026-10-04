#!/usr/bin/env bun

import { runCli } from './cli.js';

try {
	process.exit(await runCli(process.argv.slice(2)));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);
	process.exit(1);
}
