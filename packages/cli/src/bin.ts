#!/usr/bin/env -S bun --no-install
/**
 * The `epicenter` command. It installs apart from any app, which neither
 * runs nor carries it (ADR-0793).
 *
 * No top-level await, so a compiled entry can be bytecode. The exit code is
 * set, never forced, so stdout drains before the process ends.
 */
import * as appPackage from '@epicenter/app';
import { plugin } from 'bun';
import { runCli } from './cli.ts';

/**
 * `epicenter` supplies `@epicenter/app` to every `epicenter.ts` it loads
 * (ADR-0857), so an app needs a `package.json` only for its own
 * dependencies, and every app shares the one copy the command checks fields
 * with. The compiled binary carries this module and serves it the same way.
 */
plugin({
	name: '@epicenter/app',
	setup(build) {
		build.module('@epicenter/app', () => ({
			exports: appPackage,
			loader: 'object',
		}));
	},
});

void runCli(Bun.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
