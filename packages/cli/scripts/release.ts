#!/usr/bin/env bun
/** Build a platform executable, its checksum, and the matching installer without publishing them. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import manifest from '../package.json' with { type: 'json' };

const cli = join(import.meta.dir, '..');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		target: { type: 'string' },
		outdir: { type: 'string' },
	},
});
const target = values.target ?? `${process.platform}-${process.arch}`;
if (!targets.includes(target))
	throw new Error(`Choose --target ${targets.join('|')}`);
const outdir = resolve(values.outdir ?? join(cli, 'dist/release'));
await mkdir(outdir, { recursive: true });
const executable = join(outdir, `epicenter-${target}`);
const compile = Bun.spawn(
	[
		process.execPath,
		join(cli, 'scripts/compile.ts'),
		'--target',
		target === 'linux-x64' ? 'bun-linux-x64-baseline' : `bun-${target}`,
		'--outfile',
		executable,
	],
	{ stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
);
if ((await compile.exited) !== 0) process.exit(1);
const bytes = await readFile(executable);
const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
await writeFile(`${executable}.sha256`, `${checksum}\n`);
const installer = (await readFile(join(cli, 'install.sh'), 'utf8')).replaceAll(
	'__EPICENTER_VERSION__',
	manifest.version,
);
await writeFile(join(outdir, 'install.sh'), installer, { mode: 0o755 });
console.log(
	`Release files: ${outdir}\nUpload under tag epicenter-cli-v${manifest.version} when ready. Nothing has been published.`,
);
