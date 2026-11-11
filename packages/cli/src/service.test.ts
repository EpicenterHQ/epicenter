/**
 * LaunchAgent command tests.
 *
 * Verifies the installed job's content and lifecycle without invoking launchctl
 * or writing outside a temporary HOME.
 *
 * Key behaviors:
 * - Install writes an escaped plist and replaces a loaded job.
 * - Uninstall and status accept a job that is not loaded.
 * - Restart, executable selection, and platform checks fail safely.
 */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fixture } from './runner.test-support.ts';
import { serviceCommand } from './service.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const executable = join(f.root, 'installed-epicenter');
	await writeFile(executable, '');
	const calls: string[][] = [];
	let replies: Array<{ code: number; stdout: string; stderr: string }> = [];
	const dependencies = {
		platform: 'darwin',
		home: f.root,
		root: { folder: f.home, port: 4800 },
		uid: 501,
		compiled: false,
		which: (name: string): string | null =>
			({
				epicenter: executable,
				git: '/opt/git/bin/git',
				'git-lfs': '/opt/lfs/bin/git-lfs',
			})[name as 'epicenter' | 'git' | 'git-lfs'] ?? null,
		launchctl: async (args: string[]) => {
			calls.push(args);
			return replies.shift() ?? { code: 0, stdout: '', stderr: '' };
		},
	};
	return {
		...f,
		executable,
		calls,
		dependencies,
		reply(...results: Array<{ code: number; stdout: string; stderr: string }>) {
			replies = results;
		},
	};
}

const notLoaded = { code: 113, stdout: '', stderr: 'Could not find service' };
const ok = { code: 0, stdout: '', stderr: '' };

async function capture(run: () => Promise<number>) {
	let stdout = '';
	let stderr = '';
	const oldOut = process.stdout.write;
	const oldErr = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdout += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		stderr += chunk;
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: await run(), stdout, stderr };
	} finally {
		process.stdout.write = oldOut;
		process.stderr.write = oldErr;
	}
}

test('install writes the escaped plist and replaces a loaded job on every install', async () => {
	const f = await setup();
	const folder = join(f.root, 'My & <Epicenter>');
	await mkdir(folder);
	await writeFile(join(folder, 'EPICENTER.md'), '');
	f.dependencies.root.folder = folder;
	f.reply(ok, ok, ok, ok, ok, ok);
	const first = await capture(() =>
		serviceCommand(['install'], true, f.dependencies),
	);
	const second = await capture(() =>
		serviceCommand(['install'], true, f.dependencies),
	);
	expect(first.code).toBe(0);
	expect(second.code).toBe(0);
	const label = `com.epicenter.serve.my-epicenter--${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`;
	const plistPath = join(f.root, 'Library', 'LaunchAgents', `${label}.plist`);
	const logPath = join(f.root, 'Library', 'Logs', 'Epicenter', `${label}.log`);
	expect(JSON.parse(first.stdout)).toEqual({ label, plistPath, logPath });
	expect(f.calls).toEqual([
		['print', `gui/501/${label}`],
		['bootout', `gui/501/${label}`],
		['bootstrap', 'gui/501', plistPath],
		['print', `gui/501/${label}`],
		['bootout', `gui/501/${label}`],
		['bootstrap', 'gui/501', plistPath],
	]);
	const plist = await readFile(plistPath, 'utf8');
	expect(plist).toContain(`<string>${label}</string>`);
	expect(plist).toContain(
		`<string>${f.executable}</string>\n\t\t<string>serve</string>`,
	);
	expect(plist).toContain('My &amp; &lt;Epicenter&gt;');
	expect(plist).toContain('<key>RunAtLoad</key><true/>');
	expect(plist).toContain('<key>KeepAlive</key><true/>');
	expect(plist).toContain(
		'<string>/opt/git/bin:/opt/lfs/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
	);
	expect(plist.match(new RegExp(logPath, 'g'))?.length).toBe(2);
});

test('uninstall succeeds when launchctl reports the job is not loaded', async () => {
	const f = await setup();
	f.reply(notLoaded);
	const result = await capture(() =>
		serviceCommand(['uninstall'], false, f.dependencies),
	);
	expect(result.code).toBe(0);
	expect(f.calls).toEqual([
		['bootout', expect.stringContaining('gui/501/com.epicenter.serve.')],
	]);
});

test('restart fails without a plist and never calls launchctl', async () => {
	const f = await setup();
	const result = await capture(() =>
		serviceCommand(['restart'], false, f.dependencies),
	);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('is not installed');
	expect(f.calls).toEqual([]);
});

test('status parses running and stopped launchctl print output', async () => {
	const f = await setup();
	const hash = createHash('sha256').update(f.home).digest('hex').slice(0, 8);
	const label = `com.epicenter.serve.${basename(f.home).toLowerCase()}-${hash}`;
	const plistPath = join(f.root, 'Library', 'LaunchAgents', `${label}.plist`);
	await mkdir(join(f.root, 'Library', 'LaunchAgents'), { recursive: true });
	await writeFile(plistPath, 'test');
	f.reply(
		{ code: 0, stdout: 'state = running\n\tpid = 1234\n', stderr: '' },
		{ code: 0, stdout: 'state = waiting\n', stderr: '' },
		notLoaded,
	);
	const running = await capture(() =>
		serviceCommand(['status'], true, f.dependencies),
	);
	const stopped = await capture(() =>
		serviceCommand(['status'], true, f.dependencies),
	);
	const unloaded = await capture(() =>
		serviceCommand(['status'], true, f.dependencies),
	);
	expect(running.code).toBe(0);
	expect(JSON.parse(running.stdout)).toMatchObject({
		installed: true,
		running: true,
		pid: 1234,
		port: 4800,
	});
	expect(JSON.parse(stopped.stdout)).toMatchObject({
		installed: true,
		running: false,
		port: 4800,
	});
	expect(JSON.parse(stopped.stdout)).not.toHaveProperty('pid');
	expect(JSON.parse(unloaded.stdout)).toMatchObject({
		installed: true,
		running: false,
	});
	await rm(plistPath);
	const absent = await capture(() =>
		serviceCommand(['status'], true, f.dependencies),
	);
	expect(JSON.parse(absent.stdout)).toMatchObject({
		installed: false,
		running: false,
		port: 4800,
	});
	expect(f.calls).toHaveLength(3);
	await writeFile(plistPath, 'test');
	f.reply({ code: 5, stdout: '', stderr: 'Input/output error' });
	const failed = await capture(() =>
		serviceCommand(['status'], false, f.dependencies),
	);
	expect(failed.code).toBe(1);
	expect(failed.stderr).toContain('launchctl print failed: Input/output error');
});

test('install refuses an epicenter command whose realpath is in this checkout', async () => {
	const f = await setup();
	f.dependencies.which = (name) =>
		name === 'epicenter' ? resolve(import.meta.dir, 'bin.ts') : null;
	const result = await capture(() =>
		serviceCommand(['install'], false, f.dependencies),
	);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain('inside a monorepo checkout');
	expect(f.calls).toEqual([]);
});

test('every service action says macOS-only on another platform', async () => {
	const f = await setup();
	for (const action of ['install', 'uninstall', 'restart', 'status']) {
		const result = await capture(() =>
			serviceCommand([action], false, { ...f.dependencies, platform: 'linux' }),
		);
		expect(result).toEqual({
			code: 1,
			stdout: '',
			stderr: 'epicenter service is macOS-only for now.\n',
		});
	}
	expect(f.calls).toEqual([]);
});
