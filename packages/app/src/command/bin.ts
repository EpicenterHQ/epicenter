#!/usr/bin/env -S bun --no-install
/**
 * The `epicenter` command. A home depends on `@epicenter/app`, so
 * `bun install` puts this in its `node_modules/.bin`. The exit code is set,
 * never forced, so stdout drains before the process ends.
 */
import { runCli } from './cli.ts';

void runCli(Bun.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
