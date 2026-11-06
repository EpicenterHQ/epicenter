#!/usr/bin/env bun
/** Compile Messages' local program where Tauri expects its external binary. */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

const verbose = await $`rustc -vV`.text();
const host = verbose
	.split('\n')
	.find((line) => line.startsWith('host: '))
	?.slice('host: '.length)
	.trim();
if (!host) throw new Error('Could not read the host triple from rustc.');
const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
if (target !== host)
	throw new Error(
		`The Bun compiler cannot produce ${target} from ${host}; build each architecture on its matching host.`,
	);
const output = join(
	import.meta.dir,
	'..',
	'src-tauri',
	'binaries',
	`messages-server-${target}`,
);
await mkdir(dirname(output), { recursive: true });
await $`bun build --compile --minify --outfile ${output} ${join(import.meta.dir, 'serve.ts')}`;
console.error(`Compiled ${output}`);
