#!/usr/bin/env -S bun --no-install
/**
 * The `epicenter` command. The desktop app compiles this entry into the
 * binary it ships (`apps/epicenter/scripts/build-sidecar.ts`).
 *
 * No top-level await, so a compiled entry can be bytecode. The exit code is
 * set, never forced, so stdout drains before the process ends.
 */
import { runCli } from './cli.ts';

void runCli(Bun.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
