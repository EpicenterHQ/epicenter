/**
 * LaunchAgent command tests.
 *
 * Verifies plist content directly and exercises service operations through the
 * CLI with a temporary HOME and a launchctl script first on PATH.
 *
 * Key behaviors:
 * - Install writes the shell's PATH and replaces a loaded job.
 * - Uninstall accepts a job that is not loaded; restart needs an install.
 * - Status parses running and stopped jobs; other platforms get a clear error.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fixture } from './runner.test-support.ts';
import { launchAgent, serviceCommand } from './service.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const bin = join(f.root, 'bin');
	await mkdir(bin);
	const program = join(bin, 'epicenter');
	await writeFile(program, '#!/bin/sh\n');
	await chmod(program, 0o755);
	const script = join(bin, 'launchctl');
	await writeFile(
		script,
		`#!/bin/sh
cd '${f.root}'
printf '%s\\n' "$*" >> calls
if [ -f "fail-$1" ]; then
  echo 'Input/output error' >&2
  exit 5
fi
case "$1" in
  print)
    if [ -f loaded ]; then cat loaded; else echo 'Could not find service' >&2; exit 113; fi ;;
  bootstrap)
    printf 'state = running\\n\\tpid = 1234\\n' > loaded ;;
  bootout)
    if [ -f loaded ]; then rm loaded; else echo 'Could not find service' >&2; exit 113; fi ;;
  kickstart)
    if [ ! -f loaded ]; then echo 'Could not find service' >&2; exit 113; fi ;;
esac
`,
	);
	await chmod(script, 0o755);
	f.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
	return {
		...f,
		bin,
		program,
		calls: async () => {
			try {
				return (await readFile(join(f.root, 'calls'), 'utf8'))
					.trim()
					.split('\n');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
				throw error;
			}
		},
	};
}

test('launchAgent escapes values and writes the serve job', () => {
	const plist = launchAgent({
		label: `com.epicenter.serve.rock&roll<"'>`,
		program: `/bin/epicenter&<"'>`,
		folder: `/tmp/My & <Epicenter>`,
		path: `/bin:/tmp/A&B<"'>`,
		log: `/tmp/log&<"'>`,
	});
	expect(plist).toContain(
		'<string>com.epicenter.serve.rock&amp;roll&lt;&quot;&apos;&gt;</string>',
	);
	expect(plist).toContain(
		'<string>/bin/epicenter&amp;&lt;&quot;&apos;&gt;</string>\n\t\t<string>serve</string>',
	);
	expect(plist).toContain('<string>/tmp/My &amp; &lt;Epicenter&gt;</string>');
	expect(plist).toContain(
		'<string>/bin:/tmp/A&amp;B&lt;&quot;&apos;&gt;</string>',
	);
	expect(
		plist.match(/<string>\/tmp\/log&amp;&lt;&quot;&apos;&gt;<\/string>/g),
	).toHaveLength(2);
	expect(plist).toContain('<key>RunAtLoad</key><true/>');
	expect(plist).toContain('<key>KeepAlive</key><true/>');
});

test.skipIf(process.platform !== 'darwin')(
	'install writes PATH and replaces a loaded job on the second install',
	async () => {
		const f = await setup();
		const first = await f.run('service', 'install', '--json');
		const second = await f.run('service', 'install', '--json');
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		const { label, plistPath, logPath } = JSON.parse(first.stdout);
		expect(JSON.parse(second.stdout)).toEqual({ label, plistPath, logPath });
		expect(label).toMatch(/^com\.epicenter\.serve\.epicenter-[0-9a-f]{8}$/);
		expect(plistPath).toBe(
			join(f.root, 'Library', 'LaunchAgents', `${label}.plist`),
		);
		expect(logPath).toBe(
			join(f.root, 'Library', 'Logs', 'Epicenter', `${label}.log`),
		);
		expect(await readFile(plistPath, 'utf8')).toBe(
			launchAgent({
				label,
				program: f.program,
				folder: f.home,
				path: f.env.PATH!,
				log: logPath,
			}),
		);
		const job = `gui/${userInfo().uid}/${label}`;
		expect(await f.calls()).toEqual([
			`print ${job}`,
			`bootstrap gui/${userInfo().uid} ${plistPath}`,
			`print ${job}`,
			`bootout ${job}`,
			`bootstrap gui/${userInfo().uid} ${plistPath}`,
		]);
	},
);

test.skipIf(process.platform !== 'darwin')(
	'uninstall succeeds when launchctl reports the job is not loaded',
	async () => {
		const f = await setup();
		const result = await f.run('service', 'uninstall', '--json');
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ installed: false });
		expect(await f.calls()).toEqual([
			expect.stringMatching(/^bootout gui\/\d+\/com\.epicenter\.serve\./),
		]);
	},
);

test.skipIf(process.platform !== 'darwin')(
	'restart fails without a plist and never calls launchctl',
	async () => {
		const f = await setup();
		const result = await f.run('service', 'restart');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('is not installed');
		expect(await f.calls()).toEqual([]);
	},
);

test.skipIf(process.platform !== 'darwin')(
	'status reports running, stopped, unloaded, and absent jobs',
	async () => {
		const f = await setup();
		const installed = await f.run('service', 'install', '--json');
		expect(installed.code).toBe(0);
		const { label, plistPath, logPath } = JSON.parse(installed.stdout);
		const running = await f.run('service', 'status', '--json');
		expect(running.code).toBe(0);
		expect(JSON.parse(running.stdout)).toEqual({
			label,
			installed: true,
			running: true,
			pid: 1234,
			port: 4747,
			logPath,
		});
		await writeFile(join(f.root, 'loaded'), 'state = waiting\n');
		const stopped = await f.run('service', 'status', '--json');
		expect(JSON.parse(stopped.stdout)).toEqual({
			label,
			installed: true,
			running: false,
			port: 4747,
			logPath,
		});
		await rm(join(f.root, 'loaded'));
		const unloaded = await f.run('service', 'status', '--json');
		expect(JSON.parse(unloaded.stdout)).toEqual({
			label,
			installed: true,
			running: false,
			port: 4747,
			logPath,
		});
		await rm(plistPath);
		const absent = await f.run('service', 'status', '--json');
		expect(JSON.parse(absent.stdout)).toEqual({
			label,
			installed: false,
			running: false,
			port: 4747,
			logPath,
		});
		await writeFile(plistPath, 'test');
		await writeFile(join(f.root, 'fail-print'), '');
		const failed = await f.run('service', 'status');
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain(
			'launchctl print failed: Input/output error',
		);
	},
);

test.skipIf(process.platform !== 'darwin')(
	'install fails clearly when epicenter is missing from PATH',
	async () => {
		const f = await setup();
		await rm(f.program);
		f.env.PATH = f.bin;
		const result = await f.run('service', 'install');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('No epicenter command found on PATH');
		expect(await f.calls()).toEqual([]);
	},
);

test('every service action says macOS-only on another platform', async () => {
	for (const action of ['install', 'uninstall', 'restart', 'status']) {
		let stderr = '';
		const oldErr = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderr += chunk;
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(await serviceCommand([action], false, 'linux')).toBe(1);
			expect(stderr).toBe('epicenter service is macOS-only for now.\n');
		} finally {
			process.stderr.write = oldErr;
		}
	}
});
