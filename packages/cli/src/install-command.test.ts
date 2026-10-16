/**
 * `install-command` and the per-user link against scratch directories
 * instead of `<dataDir>/bin` and `/usr/local/bin`.
 *
 * Key behaviors:
 * - The per-user link is made, re-pointed when the binary moves, and left
 *   alone for a binary under macOS's App Translocation
 * - The `PATH` link points at the per-user link, so a move never touches it
 * - The `PATH` link is refused over a regular file and asks for `sudo` only
 *   where this user cannot write or make its directory
 * - Git's credential helper, written as `auth login` writes it, runs through
 *   the per-user link in a scratch `HOME`, before and after a move
 */
import { afterEach, expect, test } from 'bun:test';
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type AuthContext,
	configureGitHelper,
	resolveDeployment,
} from './auth.ts';
import {
	adminCommand,
	gitCommand,
	installCommand,
	planCommandLink,
	planLink,
} from './install-command.ts';

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) {
		try {
			chmodSync(join(dir, 'locked'), 0o755);
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A fake bundled binary, the per-user link's place, and a `PATH` directory. */
function setup(script = '#!/bin/sh\n') {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-install-')));
	scratch.push(dir);
	mkdirSync(join(dir, 'Epicenter.app'));
	const binary = join(dir, 'Epicenter.app', 'epicenter-cli');
	writeFileSync(binary, script, { mode: 0o755 });
	mkdirSync(join(dir, 'bin'));
	return {
		dir,
		binary,
		link: join(dir, 'Application Support', 'so.epicenter', 'bin', 'epicenter'),
		target: join(dir, 'bin', 'epicenter'),
	};
}

/** Move the fake app, as a person dragging it to another folder does. */
function move(dir: string) {
	renameSync(join(dir, 'Epicenter.app'), join(dir, 'Moved.app'));
	return join(dir, 'Moved.app', 'epicenter-cli');
}

const NO_APPIMAGE = {};
const TRANSLOCATED =
	'/private/var/folders/xy/abc123/T/AppTranslocation/0C1D/d/Epicenter.app/Contents/MacOS/epicenter-cli';

test('the per-user link is made, re-pointed after a move, and left alone under App Translocation', () => {
	const { dir, binary, link } = setup();
	expect(gitCommand({ binary, link, env: NO_APPIMAGE })).toEqual([link]);
	expect(readlinkSync(link)).toBe(binary);
	expect(planCommandLink(binary, link, NO_APPIMAGE).action).toBe('unchanged');

	const moved = move(dir);
	expect(planCommandLink(moved, link, NO_APPIMAGE).action).toBe('link');
	expect(gitCommand({ binary: moved, link, env: NO_APPIMAGE })).toEqual([link]);
	expect(readlinkSync(link)).toBe(moved);

	expect(planCommandLink(TRANSLOCATED, link, NO_APPIMAGE).action).toBe(
		'translocated',
	);
	expect(gitCommand({ binary: TRANSLOCATED, link, env: NO_APPIMAGE })).toEqual([
		link,
	]);
	expect(readlinkSync(link)).toBe(moved);
});

test('a terminal running the per-user link itself leaves it as it is', () => {
	const { link } = setup();
	expect(planCommandLink(link, link, NO_APPIMAGE).action).toBe('unchanged');
});

test.if(process.platform === 'linux')(
	'an AppImage copies the binary, once per version',
	() => {
		const { binary, link } = setup('#!/bin/sh\necho one\n');
		const env = { APPIMAGE: '/home/me/Epicenter.AppImage' };
		expect(planCommandLink(binary, link, env).action).toBe('copy');
		gitCommand({ binary, link, env });
		expect(lstatSync(link).isFile()).toBe(true);
		expect(readFileSync(link, 'utf8')).toBe('#!/bin/sh\necho one\n');
		expect(statSync(link).mode & 0o111).not.toBe(0);
		expect(planCommandLink(binary, link, env).action).toBe('unchanged');
	},
);

test('the PATH link points at the per-user link, survives a move, and is refused over a file', async () => {
	const { dir, binary, link, target } = setup();
	const install = (from: string, userOnly = false) =>
		installCommand({
			json: true,
			dryRun: false,
			userOnly,
			binary: from,
			link,
			target,
			env: NO_APPIMAGE,
		});
	expect(await install(binary)).toBe(0);
	expect(readlinkSync(link)).toBe(binary);
	expect(readlinkSync(target)).toBe(link);
	expect(planLink(link, target).action).toBe('unchanged');

	// The app's launch call after a move: only the per-user link changes.
	const moved = move(dir);
	expect(await install(moved, true)).toBe(0);
	expect(readlinkSync(link)).toBe(moved);
	expect(readlinkSync(target)).toBe(link);

	rmSync(target);
	symlinkSync(join(dir, 'old-epicenter'), target);
	expect(planLink(link, target)).toMatchObject({
		action: 'link',
		replacing: join(dir, 'old-epicenter'),
	});
	rmSync(target);
	writeFileSync(target, 'someone else');
	expect(planLink(link, target).action).toBe('refused');
});

test('under App Translocation the launch call makes no link and exits 1', async () => {
	const { link, target } = setup();
	expect(
		await installCommand({
			json: true,
			dryRun: false,
			userOnly: true,
			binary: TRANSLOCATED,
			link,
			target,
			env: NO_APPIMAGE,
		}),
	).toBe(1);
	expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
	expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
});

test('a directory this user cannot write or make needs an administrator', () => {
	const { dir, link } = setup();
	expect(planLink(link, join(dir, 'absent', 'epicenter'))).toMatchObject({
		action: 'link',
		needsAdmin: false,
	});
	mkdirSync(join(dir, 'locked'));
	chmodSync(join(dir, 'locked'), 0o555);
	for (const path of ['epicenter', join('bin', 'epicenter')])
		expect(planLink(link, join(dir, 'locked', path))).toMatchObject({
			needsAdmin: true,
		});
	const target = join(dir, 'locked', 'epicenter');
	expect(adminCommand({ binary: link, target })).toBe(
		`sudo mkdir -p '${join(dir, 'locked')}' && sudo ln -sfn '${link}' '${target}'`,
	);
});

test('a dry run changes nothing', async () => {
	const { dir, binary, link, target } = setup();
	symlinkSync(join(dir, 'old-epicenter'), target);
	expect(
		await installCommand({
			json: false,
			dryRun: true,
			binary,
			link,
			target,
			env: NO_APPIMAGE,
		}),
	).toBe(0);
	expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
	expect(readlinkSync(target)).toBe(join(dir, 'old-epicenter'));
});

test('without an administrator and without a person to ask, it exits 1, names the command, and still makes the per-user link', async () => {
	const { dir, binary, link } = setup();
	mkdirSync(join(dir, 'locked'));
	chmodSync(join(dir, 'locked'), 0o555);
	const target = join(dir, 'locked', 'epicenter');
	expect(
		await installCommand({
			json: true,
			dryRun: false,
			binary,
			link,
			target,
			env: NO_APPIMAGE,
			interactive: false,
		}),
	).toBe(1);
	expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
	expect(readlinkSync(link)).toBe(binary);
});

test("Git's credential helper runs through the per-user link, before and after a move", async () => {
	// Stands in for the bundled binary, answering as `auth git-credential get` does.
	const answering = (password: string) =>
		`#!/bin/sh\n[ "$1 $2 $3" = "auth git-credential get" ] || exit 2\ncat >/dev/null\nprintf 'username=epicenter\\npassword=${password}\\n'\n`;
	const { dir, binary, link } = setup(answering('before'));
	const home = join(dir, 'home');
	mkdirSync(home);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: join(home, '.config'),
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
	};
	const deployment = resolveDeployment('http://127.0.0.1:9');
	const ctx = { deployment } as AuthContext;

	// What `auth login` writes, with `gitCommand()` remaking the link first.
	const configured = await configureGitHelper(
		ctx,
		gitCommand({ binary, link, env: NO_APPIMAGE }),
		env,
	);
	expect(configured.data).toBe(`!'${link}' auth git-credential`);

	const url = new URL(deployment.audiences.git);
	const fill = () =>
		Bun.spawnSync(['git', 'credential', 'fill'], {
			env,
			stdin: new TextEncoder().encode(
				`protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=${url.pathname.slice(1)}/x.git\n\n`,
			),
		}).stdout.toString();
	expect(fill()).toContain('password=before\n');

	// A new version in a new place; the next launch remakes only the link.
	const moved = move(dir);
	writeFileSync(moved, answering('after'));
	gitCommand({ binary: moved, link, env: NO_APPIMAGE });
	expect(fill()).toContain('password=after\n');
});
