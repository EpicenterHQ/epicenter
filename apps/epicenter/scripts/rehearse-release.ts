#!/usr/bin/env bun
/** Build two complete Epicenter apps, then verify a real signed bundle replacement. */
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { buildRelease } from './release.js';

const appDir = resolve(import.meta.dir, '..');
const output = resolve(
	process.argv[2] ?? '.artifacts/epicenter-release-rehearsal',
);
// Tauri rejects a macOS executable path containing symlinks, including /var.
const root = await realpath(
	await mkdtemp(join(tmpdir(), 'epicenter-release-rehearsal-')),
);
await Bun.write(
	join(root, 'EPICENTER-release-rehearsal'),
	'Isolated packaged app update\n',
);
const privateKey = join(root, 'updater.key');
const cli = join(appDir, 'node_modules/@tauri-apps/cli/tauri.js');
async function command(args: string[]) {
	const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' });
	if ((await child.exited) !== 0) throw new Error(`Failed: ${args[0]}`);
}
let feed: object | null = null;
let archive: string | null = null;
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/epicenter/stable.json' && feed) return Response.json(feed);
		if (path === '/Epicenter.app.tar.gz' && archive)
			return new Response(Bun.file(archive));
		return new Response(null, { status: 204 });
	},
});
try {
	await command([
		process.execPath,
		cli,
		'signer',
		'generate',
		'--ci',
		'-p',
		'',
		'-w',
		privateKey,
	]);
	process.env.TAURI_SIGNING_PRIVATE_KEY = privateKey;
	process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
	const publicKey = (await Bun.file(`${privateKey}.pub`).text()).trim();
	process.env.EPICENTER_UPDATER_PUBLIC_KEY = publicKey;
	await mkdir(output, { recursive: true });
	const endpoint = `${server.url}epicenter/stable.json`;
	const first = await buildRelease('epicenter-v0.0.1', join(output, '0.0.1'), {
		endpoint,
	});
	const installed = join(root, 'installed/Epicenter Release Rehearsal.app');
	await cp(first.app, installed, { recursive: true });
	const second = await buildRelease('epicenter-v0.0.2', join(output, '0.0.2'), {
		endpoint,
	});
	archive = join(output, '0.0.2', second.part.archive);
	feed = {
		version: '0.0.2',
		notes: 'Packaged Epicenter update rehearsal',
		platforms: {
			[second.part.target]: {
				url: `${server.url}Epicenter.app.tar.gz`,
				signature: second.part.signature,
			},
		},
	};
	await command([
		'cargo',
		'build',
		'--locked',
		'--manifest-path',
		join(import.meta.dir, 'release-check/Cargo.toml'),
	]);
	const probe = join(
		import.meta.dir,
		'release-check/target/debug/epicenter-release-check',
	);
	await command([probe, 'install', root, '0.0.1', endpoint, publicKey]);
	await command(['diff', '-qr', installed, second.app]);
	const receipt = await Bun.file(
		join(installed, 'Contents/Resources/apps-dist/release.json'),
	).json();
	if (receipt.version !== '0.0.2' || !receipt.rehearsal)
		throw new Error('Installed bundle did not advance');
	for (const page of ['home', 'folders']) {
		if (
			!(await Bun.file(
				join(installed, 'Contents/Resources/apps-dist', page, 'index.html'),
			).exists())
		)
			throw new Error(`Missing page ${page}`);
	}
	// Keep the exact upgraded bundle for a native launch with isolated directories.
	await cp(installed, join(output, 'Epicenter Release Rehearsal.app'), {
		recursive: true,
	});
	await Bun.write(
		join(output, 'report.json'),
		JSON.stringify(
			{ passed: true, from: '0.0.1', to: '0.0.2', endpoint, receipt },
			null,
			2,
		),
	);
	console.log(
		`Packaged Epicenter-to-Epicenter update passed. Evidence: ${output}`,
	);
	if (process.argv.includes('--interactive')) {
		const gui = join(root, 'gui');
		await mkdir(gui);
		await command([
			'tar',
			'-xzf',
			join(output, '0.0.1', first.part.archive),
			'-C',
			gui,
		]);
		const executable = join(
			gui,
			'Epicenter Release Rehearsal.app/Contents/MacOS/epicenter',
		);
		Bun.spawn([executable], {
			env: {
				...process.env,
				EPICENTER_DATA_DIR: join(root, 'data'),
				EPICENTER_FOLDER_DIR: join(root, 'folders'),
			},
			stdout: 'inherit',
			stderr: 'inherit',
		});
		console.log(
			`Native rehearsal app: ${join(gui, 'Epicenter Release Rehearsal.app')}`,
		);
		console.log(
			'Use Check for Updates in the app menu. Quit the rehearsal app before pressing Return here.',
		);
		const terminal = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			await terminal.question('Rehearsal complete: ');
		} finally {
			terminal.close();
		}
	}
} finally {
	server.stop(true);
	await rm(root, { recursive: true, force: true });
}
