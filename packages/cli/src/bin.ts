#!/usr/bin/env -S bun --no-install
/**
 * The `epicenter` command, run from source. The desktop app compiles the same
 * `runCli` into the binary it ships (`apps/epicenter/src/epicenter-binary.ts`).
 *
 * No top-level await, so a compiled entry can be bytecode. The exit code is
 * set, never forced, so stdout drains before the process ends.
 */
import { runCli } from './cli.ts';

void runCli(Bun.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
