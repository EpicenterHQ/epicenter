#!/usr/bin/env -S bun --no-install
/**
 * The `epicenter` command. It installs apart from any app, which neither
 * runs nor carries it (ADR-0793).
 *
 * No top-level await, so a compiled entry can be bytecode. The exit code is
 * set, never forced, so stdout drains before the process ends.
 */
import { runCli } from './cli.ts';

void runCli(Bun.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
