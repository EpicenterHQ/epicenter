/**
 * `install-command` and the one link it keeps, against scratch directories
 * instead of `~/.local/bin`.
 *
 * Key behaviors:
 * - The link is made, re-pointed when the binary moves, and left alone for a
 *   binary under macOS's App Translocation, which exits 1
 * - A regular file at the link's path is refused and left as it is
 * - Git's credential helper, written as `auth login` writes it, runs through
 *   the link in a scratch `HOME`, before and after a move
 */
import { afterEach, expect, test } from 'bun:test';
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
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
	gitCommand,
	installCommand,
	planCommandLink,
} from './install-command.ts';

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A fake bundled binary and the link's place. */
function setup(script = '#!/bin/sh\n') {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-install-')));
	scratch.push(dir);
	mkdirSync(join(dir, 'Epicenter.app'));
	const binary = join(dir, 'Epicenter.app', 'epicenter-cli');
	writeFileSync(binary, script, { mode: 0o755 });
	return { dir, binary, link: join(dir, '.local', 'bin', 'epicenter') };
}

/** Move the fake app, as a person dragging it to another folder does. */
function move(dir: string) {
	renameSync(join(dir, 'Epicenter.app'), join(dir, 'Moved.app'));
	return join(dir, 'Moved.app', 'epicenter-cli');
}

const TRANSLOCATED =
	'/private/var/folders/xy/abc123/T/AppTranslocation/0C1D/d/Epicenter.app/Contents/MacOS/epicenter-cli';

test('the link is made, re-pointed after a move, and left alone under App Translocation', async () => {
	const { dir, binary, link } = setup();
	expect(await installCommand({ json: true, binary, link })).toBe(0);
	expect(readlinkSync(link)).toBe(binary);
	expect(planCommandLink(binary, link).action).toBe('unchanged');

	// The app's launch call after a move.
	const moved = move(dir);
	expect(planCommandLink(moved, link).action).toBe('link');
	expect(await installCommand({ json: true, binary: moved, link })).toBe(0);
	expect(readlinkSync(link)).toBe(moved);

	expect(await installCommand({ json: true, binary: TRANSLOCATED, link })).toBe(
		1,
	);
	expect(readlinkSync(link)).toBe(moved);
});

test('a terminal running the link itself leaves it as it is', () => {
	const { link } = setup();
	expect(planCommandLink(link, link).action).toBe('unchanged');
});

test('a regular file at the link is refused and kept', async () => {
	const { dir, binary, link } = setup();
	mkdirSync(join(dir, '.local', 'bin'), { recursive: true });
	writeFileSync(link, 'someone else');
	expect(await installCommand({ json: true, binary, link })).toBe(1);
	expect(lstatSync(link).isFile()).toBe(true);
	expect(readFileSync(link, 'utf8')).toBe('someone else');
});

test('every Git configuration names the link and makes nothing', () => {
	const { link } = setup();
	expect(gitCommand(link)).toEqual([link]);
	expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
});

test("Git's credential helper runs through the link, before and after a move", async () => {
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

	await installCommand({ json: true, binary, link });
	// What `auth login` writes.
	const configured = await configureGitHelper(ctx, gitCommand(link), env);
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
	await installCommand({ json: true, binary: moved, link });
	expect(fill()).toContain('password=after\n');
});
