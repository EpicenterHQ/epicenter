#!/usr/bin/env bun
/**
 * Compile the `epicenter` CLI (ADR-0556) where Tauri expects its external
 * binary. The app links to the bundled sidecar from its machine home.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

const appDir = join(import.meta.dir, '..');

async function hostTargetTriple(): Promise<string> {
	const verbose = await $`rustc -vV`.text();
	const host = verbose
		.split('\n')
		.find((line) => line.startsWith('host: '))
		?.slice('host: '.length)
		.trim();
	if (!host) throw new Error('Could not read the host triple from rustc.');
	return host;
}

const environment =
	process.env.TAURI_ENV_DEBUG === 'true' ? 'development' : 'production';
const hostTriple = await hostTargetTriple();
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple;
if (targetTriple !== hostTriple) {
	throw new Error(
		`The Bun compiler cannot produce ${targetTriple} from ${hostTriple}; build each architecture on its matching host.`,
	);
}

const outfile = join(
	appDir,
	'src-tauri',
	'binaries',
	`epicenter-cli-${targetTriple}`,
);
await mkdir(dirname(outfile), { recursive: true });

console.error(`Compiling the epicenter binary -> ${outfile}`);
// The CLI's compile script builds the sync core's addon first, then embeds it.
const cli = join(appDir, '..', '..', 'packages', 'cli');
await $`bun run --cwd ${cli} compile --outfile ${outfile} --environment ${environment}`;
console.error('The epicenter binary compiled.');
