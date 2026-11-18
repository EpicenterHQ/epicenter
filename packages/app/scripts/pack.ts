#!/usr/bin/env bun
/**
 * Pack `@epicenter/app` as the registry would receive it. For trying an
 * unreleased change against a home, and for the owner to publish from. It
 * publishes nothing.
 *
 * `bun pm pack` rewrites `catalog:` to real versions, so the tarball resolves
 * outside this repository; this script refuses a tarball where one is left.
 *
 * Bun caches a tarball by its path, so a home that installed
 * `epicenter-app-0.7.0.tgz` from one path keeps that content however the
 * file changes. The tarball therefore lands in a folder named for its
 * content, `<outdir>/<hash>/`, which is a new path whenever it changes.
 *
 * ```sh
 * bun run --cwd packages/app pack            # into packages/app/dist/pack/<hash>/
 * bun run --cwd packages/app pack --outdir /tmp/epicenter-pack
 * ```
 */
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const app = join(import.meta.dir, '..');
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { outdir: { type: 'string' } },
});
const outdir = resolve(values.outdir ?? join(app, 'dist', 'pack'));
await mkdir(outdir, { recursive: true });
const staging = await mkdtemp(join(outdir, '.packing-'));

async function run(command: string[], cwd: string) {
	const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(`${command.join(' ')} failed in ${cwd}:\n${stderr}`);
	return stdout;
}

try {
	await run(
		[process.execPath, 'pm', 'pack', '--destination', staging, '--quiet'],
		app,
	);
	const [file] = await readdir(staging);
	if (!file) throw new Error('bun pm pack wrote no tarball');
	const manifest = await run(
		['tar', '-xzOf', join(staging, file), 'package/package.json'],
		staging,
	);
	const left = manifest.match(/"(?:catalog|workspace):[^"]*"/g);
	if (left)
		throw new Error(
			`${file} still names ${left.join(', ')}, which resolves only in this repository`,
		);
	const hash = new Bun.CryptoHasher('sha256')
		.update(await Bun.file(join(staging, file)).bytes())
		.digest('hex')
		.slice(0, 12);
	const folder = join(outdir, hash);
	await rm(folder, { recursive: true, force: true });
	await rename(staging, folder);
	const { name, version } = JSON.parse(manifest) as {
		name: string;
		version: string;
	};
	const overrides = { [name]: `file:${join(folder, file)}` };
	console.log(
		`Packed ${name} ${version} into ${join(folder, file)}. Nothing was published.\n\nTo run a home on it, add this to the home's package.json, run bun install there, and restart serve:\n\n${JSON.stringify({ overrides }, null, 2)}`,
	);
} finally {
	await rm(staging, { recursive: true, force: true });
}
