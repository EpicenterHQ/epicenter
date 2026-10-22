#!/usr/bin/env bun
/** Epicenter's signed macOS build, artifact collection, and feed publication. */
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUNDLED_PAGES } from './build-bundled-apps.js';

export const UPDATE_FEED = 'https://updates.epicenter.so/epicenter/stable.json';
const appDir = resolve(import.meta.dir, '..');
const repoDir = resolve(appDir, '../..');
const tauriCli = join(appDir, 'node_modules/@tauri-apps/cli/tauri.js');

export function releaseVersion(tag: string) {
	const match =
		/^epicenter-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
	const version = match?.[1];
	if (!version || !Bun.semver.satisfies(version, '*'))
		throw new Error(
			'Expected an Epicenter stable tag such as epicenter-v0.0.1',
		);
	return version;
}

export type ReleasePart = {
	rehearsal: boolean;
	product: 'epicenter';
	version: string;
	tag: string;
	commit: string;
	target: string;
	archive: string;
	signature: string;
	dmg: string | null;
};

export function collect(
	parts: ReleasePart[],
	tag: string,
	targets: readonly string[],
) {
	const version = releaseVersion(tag);
	if (
		parts.length !== targets.length ||
		new Set(parts.map((p) => p.target)).size !== targets.length
	) {
		throw new Error(
			'Every required architecture must supply exactly one build',
		);
	}
	const commit = parts[0]?.commit;
	const platforms: Record<string, { url: string; signature: string }> = {};
	for (const part of parts) {
		if (
			part.rehearsal !== false ||
			part.product !== 'epicenter' ||
			part.tag !== tag ||
			part.version !== version ||
			part.commit !== commit ||
			!/^[a-f0-9]{40}$/.test(part.commit) ||
			!targets.includes(part.target) ||
			part.archive !== `Epicenter_${version}_${part.target}.app.tar.gz` ||
			part.dmg !== `Epicenter_${version}_${part.target}.dmg` ||
			!part.signature.trim()
		) {
			throw new Error(
				'Release builds disagree on product, source, version, target, or signature',
			);
		}
		platforms[part.target] = {
			url: `https://github.com/EpicenterHQ/epicenter/releases/download/${tag}/${part.archive}`,
			signature: part.signature,
		};
	}
	return { version, notes: `Epicenter ${version}`, platforms };
}

export function requireNewer(candidate: string, current: string) {
	if (!Bun.semver.satisfies(candidate, `>${current}`))
		throw new Error(`Feed stays at ${current}: ${candidate} is not newer`);
}

/** Check the actual uploaded files before completing a draft or publishing it. */
export function verifyAssets(
	manifest: ReturnType<typeof collect>,
	tag: string,
	assets: readonly { name: string }[],
	signatures: Readonly<Record<string, string>>,
) {
	const version = releaseVersion(tag);
	const targets = ['darwin-aarch64', 'darwin-x86_64'];
	if (
		manifest.version !== version ||
		Object.keys(manifest.platforms).sort().join() !== targets.join()
	)
		throw new Error('Feed must contain both matching macOS architectures');
	for (const target of targets) {
		const filename = `Epicenter_${version}_${target}.app.tar.gz`;
		const platform = manifest.platforms[target];
		if (
			platform?.url !==
				`https://github.com/EpicenterHQ/epicenter/releases/download/${tag}/${filename}` ||
			!platform.signature.trim() ||
			platform.signature !== signatures[`${filename}.sig`]?.trim()
		)
			throw new Error('Feed differs from the signed release artifacts');
		for (const name of [
			filename,
			`${filename}.sig`,
			`Epicenter_${version}_${target}.dmg`,
		]) {
			if (!assets.some((asset) => asset.name === name))
				throw new Error(`Release is missing ${name}`);
		}
	}
}

async function run(args: string[], cwd = repoDir, inherit = false) {
	const child = Bun.spawn(args, {
		cwd,
		env: process.env,
		stdout: inherit ? 'inherit' : 'pipe',
		stderr: inherit ? 'inherit' : 'pipe',
	});
	const stdout = child.stdout
		? new Response(child.stdout).text()
		: Promise.resolve('');
	const stderr = child.stderr
		? new Response(child.stderr).text()
		: Promise.resolve('');
	const [code, out, err] = await Promise.all([child.exited, stdout, stderr]);
	if (code !== 0) throw new Error(err || out || `${args[0]} exited ${code}`);
	return out.trim();
}

function required(name: string) {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} before building a signed release`);
	return value;
}

export async function buildRelease(
	tag: string,
	output: string,
	rehearsal?: { endpoint: string },
) {
	if (process.platform !== 'darwin')
		throw new Error('Epicenter releases are verified on macOS first');
	const version = releaseVersion(tag);
	const publicKey = required('EPICENTER_UPDATER_PUBLIC_KEY');
	required('TAURI_SIGNING_PRIVATE_KEY');
	const config = await Bun.file(
		join(appDir, 'src-tauri/tauri.conf.json'),
	).json();
	const pkg = await Bun.file(join(appDir, 'package.json')).json();
	if (!rehearsal && (config.version !== version || pkg.version !== version))
		throw new Error('The app and package versions must match the release tag');
	const commit = await run(['git', 'rev-parse', 'HEAD']);
	if (!rehearsal) {
		if ((await run(['git', 'rev-parse', `${tag}^{commit}`])) !== commit)
			throw new Error('Build the exact tagged commit');
		if (await run(['git', 'status', '--porcelain', '--untracked-files=no']))
			throw new Error('Release source has tracked changes');
		const identity = required('APPLE_SIGNING_IDENTITY');
		if (identity === '-')
			throw new Error(
				'Distribution releases require an Apple signing identity',
			);
		required('APPLE_ID');
		required('APPLE_PASSWORD');
		required('APPLE_TEAM_ID');
	}
	const scratch = await mkdtemp(join(tmpdir(), 'epicenter-release-build-'));
	const target = `darwin-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
	const overlay = {
		version,
		...(rehearsal
			? {
					productName: 'Epicenter Release Rehearsal',
					identifier: 'so.epicenter.release-rehearsal',
				}
			: {}),
		build: { beforeBuildCommand: '' },
		bundle: {
			targets: rehearsal ? ['app'] : ['app', 'dmg'],
			createUpdaterArtifacts: true,
			macOS: {
				signingIdentity: rehearsal ? '-' : required('APPLE_SIGNING_IDENTITY'),
			},
		},
		plugins: {
			updater: {
				pubkey: publicKey,
				endpoints: [rehearsal?.endpoint ?? UPDATE_FEED],
				requireSignedVersion: true,
				...(rehearsal ? { dangerousInsecureTransportProtocol: true } : {}),
			},
			...(rehearsal
				? {
						'deep-link': {
							desktop: { schemes: ['epicenter-release-rehearsal'] },
						},
					}
				: {}),
		},
	};
	try {
		// The pages and CLI are built once, then one receipt ships in that same bundle.
		await run([process.execPath, 'run', 'build:desktop'], appDir, true);
		const receipt = {
			product: 'epicenter',
			version,
			tag,
			commit,
			target,
			bundledApps: BUNDLED_PAGES,
			rehearsal: !!rehearsal,
		};
		await Bun.write(
			join(appDir, 'dist/release.json'),
			JSON.stringify(receipt, null, 2),
		);
		const overlayPath = join(scratch, 'tauri.release.json');
		await Bun.write(overlayPath, JSON.stringify(overlay));
		await run(
			[process.execPath, tauriCli, 'build', '--config', overlayPath],
			appDir,
			true,
		);
		const bundles = join(appDir, 'src-tauri/target/release/bundle');
		const appName = rehearsal
			? 'Epicenter Release Rehearsal.app'
			: 'Epicenter.app';
		await run([
			'codesign',
			'--verify',
			'--deep',
			'--strict',
			join(bundles, 'macos', appName),
		]);
		if (!rehearsal)
			await run([
				'xcrun',
				'stapler',
				'validate',
				join(bundles, 'macos', appName),
			]);
		const archive = `Epicenter_${version}_${target}.app.tar.gz`;
		const out = resolve(output);
		await mkdir(out, { recursive: true });
		const signature = (
			await Bun.file(join(bundles, 'macos', `${appName}.tar.gz.sig`)).text()
		).trim();
		await cp(join(bundles, 'macos', `${appName}.tar.gz`), join(out, archive));
		await Bun.write(join(out, `${archive}.sig`), signature);
		let dmg: string | null = null;
		if (!rehearsal) {
			const files = (await readdir(join(bundles, 'dmg'))).filter((name) =>
				name.endsWith('.dmg'),
			);
			const expected = `Epicenter_${version}_${process.arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`;
			if (!files.includes(expected)) throw new Error(`Missing ${expected}`);
			dmg = `Epicenter_${version}_${target}.dmg`;
			await cp(join(bundles, 'dmg', expected), join(out, dmg));
			await run(['xcrun', 'stapler', 'validate', join(out, dmg)]);
		}
		const part: ReleasePart = {
			rehearsal: !!rehearsal,
			product: 'epicenter',
			version,
			tag,
			commit,
			target,
			archive,
			signature,
			dmg,
		};
		await Bun.write(join(out, 'part.json'), JSON.stringify(part, null, 2));
		return { part, app: join(bundles, 'macos', appName) };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [operation, tag, directory] = process.argv.slice(2);
	if (!tag || !directory)
		throw new Error(
			'Usage: release.ts build|collect|collect-draft|publish TAG OUTPUT',
		);
	if (operation === 'build') {
		await buildRelease(tag, directory);
	} else if (operation === 'collect' || operation === 'collect-draft') {
		let draft: { isDraft: boolean; assets: { name: string }[] } | undefined;
		if (operation === 'collect-draft') {
			draft = JSON.parse(
				await run([
					'gh',
					'release',
					'view',
					tag,
					'--repo',
					'EpicenterHQ/epicenter',
					'--json',
					'isDraft,assets',
				]),
			);
			if (!draft?.isDraft)
				throw new Error('Only an unpublished draft can be completed');
			await mkdir(directory, { recursive: true });
			await run([
				'gh',
				'release',
				'download',
				tag,
				'--repo',
				'EpicenterHQ/epicenter',
				'--pattern',
				'*.part.json',
				'--pattern',
				'*.sig',
				'--dir',
				directory,
				'--clobber',
			]);
		}
		const parts = await Promise.all(
			(await readdir(directory, { recursive: true }))
				.filter((name) => name.endsWith('part.json'))
				.map(
					(name) =>
						Bun.file(join(directory, name)).json() as Promise<ReleasePart>,
				),
		);
		const manifest = collect(parts, tag, ['darwin-aarch64', 'darwin-x86_64']);
		if (draft) {
			const commit = await run(['git', 'rev-parse', 'HEAD']);
			if (parts.some((part) => part.commit !== commit))
				throw new Error(
					'Draft artifacts do not match the checked-out release commit',
				);
			const signatures = Object.fromEntries(
				await Promise.all(
					parts.map(async (part) => [
						`${part.archive}.sig`,
						await Bun.file(join(directory, `${part.archive}.sig`)).text(),
					]),
				),
			);
			verifyAssets(manifest, tag, draft.assets, signatures);
		}
		await Bun.write(
			join(directory, 'stable.json'),
			JSON.stringify(manifest, null, 2),
		);
	} else if (operation === 'publish') {
		const version = releaseVersion(tag);
		const release = JSON.parse(
			await run([
				'gh',
				'release',
				'view',
				tag,
				'--repo',
				'EpicenterHQ/epicenter',
				'--json',
				'isDraft,isPrerelease,assets',
			]),
		);
		const manifest = await Bun.file(join(directory, 'stable.json')).json();
		if (release.isPrerelease || manifest.version !== version)
			throw new Error('Publish a matching stable release');
		await run([
			'gh',
			'release',
			'download',
			tag,
			'--repo',
			'EpicenterHQ/epicenter',
			'--pattern',
			'*.sig',
			'--dir',
			directory,
			'--clobber',
		]);
		const signatures = Object.fromEntries(
			await Promise.all(
				['darwin-aarch64', 'darwin-x86_64'].map(async (target) => {
					const filename = `Epicenter_${version}_${target}.app.tar.gz.sig`;
					return [filename, await Bun.file(join(directory, filename)).text()];
				}),
			),
		);
		verifyAssets(manifest, tag, release.assets, signatures);
		let response: Response | undefined;
		try {
			response = await fetch(UPDATE_FEED, {
				headers: { 'Cache-Control': 'no-cache' },
			});
		} catch (error) {
			if (process.env.FIRST_RELEASE !== 'true') throw error;
		}
		if (response?.ok) {
			const current = await response.json();
			if (JSON.stringify(current) === JSON.stringify(manifest)) {
				console.log('This release is already on the feed.');
				process.exit(0);
			}
			requireNewer(version, current.version);
		} else if (
			!(
				process.env.FIRST_RELEASE === 'true' &&
				(!response || response.status === 404)
			)
		) {
			throw new Error(`Cannot read current feed: HTTP ${response?.status}`);
		}
		if (release.isDraft)
			await run(
				[
					'gh',
					'release',
					'edit',
					tag,
					'--repo',
					'EpicenterHQ/epicenter',
					'--draft=false',
					'--latest=false',
				],
				repoDir,
				true,
			);
		for (const platform of Object.values(manifest.platforms) as {
			url: string;
		}[]) {
			if (!(await fetch(platform.url, { method: 'HEAD' })).ok)
				throw new Error(
					'Published downloads are not reachable; retry publication before advancing the feed',
				);
		}
		const assets = join(directory, 'feed');
		await mkdir(join(assets, 'epicenter'), { recursive: true });
		await Bun.write(
			join(assets, 'epicenter/stable.json'),
			JSON.stringify(manifest),
		);
		await cp(
			join(appDir, 'release-feed/public/_headers'),
			join(assets, '_headers'),
		);
		await run(
			[
				process.execPath,
				'x',
				'--no-install',
				'wrangler',
				'deploy',
				'--config',
				'apps/epicenter/release-feed/wrangler.jsonc',
				'--assets',
				resolve(assets),
			],
			repoDir,
			true,
		);
	} else throw new Error(`Unknown release operation: ${operation}`);
}
