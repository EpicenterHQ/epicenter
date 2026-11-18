#!/usr/bin/env -S bun --no-install
/**
 * The `epicenter` command. A home depends on it: `bun install` at the top of
 * the home puts it in `node_modules/.bin`, beside the one `@epicenter/app`
 * this command and every app resolve.
 *
 * The exit code is set, never forced, so stdout drains before the process
 * ends.
 */
import { runCli } from './cli.ts';

void runCli(Bun.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
