#!/usr/bin/env bun
/**
 * Compile the `epicenter` CLI (ADR-0556) where Tauri expects its external
 * binary. The bundle names it `epicenter-cli` because Tauri refuses a sidecar
 * named like the Cargo package, `epicenter`; `epicenter install-command`
 * links it onto `PATH` as `epicenter`.
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
// --bytecode needs an entry graph without top-level await, which the CLI's
// entry keeps.
const entry = join(appDir, '..', '..', 'packages', 'cli', 'src', 'bin.ts');
await $`bun build --compile --minify --bytecode --outfile ${outfile} ${entry}`;
console.error('The epicenter binary compiled.');
