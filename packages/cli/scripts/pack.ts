#!/usr/bin/env bun
/**
 * Pack `@epicenter/app`, `@epicenter/theme` and `@epicenter/cli` as the
 * registry would receive them, into one folder. For trying an unreleased
 * change against a home, and for the owner to publish from. It publishes
 * nothing.
 *
 * `bun pm pack` rewrites `catalog:` and `workspace:*` to real versions, so
 * the tarballs resolve outside this repository; this script refuses a
 * tarball where one is left.
 *
 * Bun caches a tarball by its path, so a home that installed
 * `epicenter-app-0.5.0.tgz` from one path keeps that content however the
 * file changes. The tarballs therefore land in a folder named for their
 * content, `<outdir>/<hash>/`, which is a new path whenever any of them
 * changes.
 *
 * ```sh
 * bun run --cwd packages/cli pack            # into packages/cli/dist/pack/<hash>/
 * bun run --cwd packages/cli pack --outdir /tmp/epicenter-pack
 * ```
 */
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const cli = join(import.meta.dir, '..');
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { outdir: { type: 'string' } },
});
const outdir = resolve(values.outdir ?? join(cli, 'dist', 'pack'));
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
	const hasher = new Bun.CryptoHasher('sha256');
	const packed: { name: string; file: string }[] = [];
	// Dependencies first, so the list reads in the order a home needs them.
	for (const folder of ['app', 'theme', 'cli']) {
		const before = new Set(await readdir(staging));
		await run(
			[process.execPath, 'pm', 'pack', '--destination', staging, '--quiet'],
			join(cli, '..', folder),
		);
		const [file] = (await readdir(staging)).filter((name) => !before.has(name));
		if (!file) throw new Error(`bun pm pack wrote no tarball for ${folder}`);
		const manifest = await run(
			['tar', '-xzOf', join(staging, file), 'package/package.json'],
			staging,
		);
		const left = manifest.match(/"(?:catalog|workspace):[^"]*"/g);
		if (left)
			throw new Error(
				`${file} still names ${left.join(', ')}, which resolves only in this repository`,
			);
		hasher.update(await Bun.file(join(staging, file)).bytes());
		packed.push({ name: JSON.parse(manifest).name, file });
	}
	const folder = join(outdir, hasher.digest('hex').slice(0, 12));
	await rm(folder, { recursive: true, force: true });
	await rename(staging, folder);
	const overrides = Object.fromEntries(
		packed.map(({ name, file }) => [name, `file:${join(folder, file)}`]),
	);
	console.log(
		`Packed ${packed.length} packages into ${folder}. Nothing was published.\n\nTo run a home on them, add this to the home's package.json, run bun install there, and restart serve:\n\n${JSON.stringify({ overrides }, null, 2)}`,
	);
} finally {
	await rm(staging, { recursive: true, force: true });
}
