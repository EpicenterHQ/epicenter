/**
 * Service command tests: the macOS LaunchAgent and the Linux systemd user unit.
 *
 * Verifies the plist and the unit directly, and exercises each platform's
 * operations through the CLI with a temporary HOME and a fake launchctl, or
 * fake systemctl and loginctl, first on PATH. The Linux operations run on
 * any computer, by running `serviceCommand` for `linux` in its own process.
 *
 * Key behaviors:
 * - Install writes the shell's PATH and replaces a running job.
 * - Install refuses when Git cannot say who commits from its configuration.
 * - Uninstall accepts a job that is not there; restart needs an install.
 * - Status parses running and stopped jobs; Linux says whether linger is on.
 * - Linux names the way out when there is no user session to reach.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from './runner.test-support.ts';
import { launchAgent, serviceCommand, systemdUnit } from './service.ts';

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
	// The job has none of the shell's GIT_AUTHOR_*, so install reads Git's configuration.
	const gitconfig = join(f.root, 'gitconfig');
	await writeFile(
		gitconfig,
		'[user]\n\tname = Epicenter Test\n\temail = epicenter-test@example.com\n',
	);
	f.env.GIT_CONFIG_GLOBAL = gitconfig;
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

test.skipIf(process.platform !== 'darwin')(
	'install refuses when Git has no identity of its own, before writing anything',
	async () => {
		const f = await setup();
		f.env.GIT_CONFIG_GLOBAL = '/dev/null';
		const result = await f.run('service', 'install');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Git does not know who you are');
		expect(result.stderr).toContain('git config --global user.email');
		expect(await f.calls()).toEqual([]);
	},
);

test('every service action names the platforms it runs on elsewhere', async () => {
	for (const action of ['install', 'uninstall', 'restart', 'status']) {
		let stderr = '';
		const oldErr = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderr += chunk;
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(await serviceCommand([action], false, 'win32')).toBe(1);
			expect(stderr).toBe('epicenter service runs on macOS and Linux.\n');
		} finally {
			process.stderr.write = oldErr;
		}
	}
});

test('systemdUnit escapes values and writes the serve job', () => {
	const unit = systemdUnit({
		program: `/opt/my "bin"/100%\\$HOME/epicenter`,
		folder: '/srv/My 100% Epicenter',
		environment: { PATH: '/usr/bin:/a "b"/%h/$x\\y', TZ: 'Europe/Paris' },
	});
	expect(unit).toBe(`[Unit]
Description=epicenter serve in /srv/My 100%% Epicenter
StartLimitIntervalSec=0

[Service]
ExecStart="/opt/my \\"bin\\"/100%%\\\\$$HOME/epicenter" serve
WorkingDirectory=/srv/My 100%% Epicenter
Environment="PATH=/usr/bin:/a \\"b\\"/%%h/$x\\\\y"
Environment="TZ=Europe/Paris"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
	expect(() =>
		systemdUnit({
			program: '/bin/epicenter',
			folder: '/srv/a\nb',
			environment: {},
		}),
	).toThrow('control character');
});

/**
 * A fixture whose PATH starts with fake `systemctl` and `loginctl`, and a
 * `linux` that runs `epicenter service` for Linux in its own process.
 * `systemctl` records each call's arguments after `--user` in `calls`; a
 * restart makes the unit active; `nobus` makes every call fail as with no
 * user session; `linger` makes `loginctl` say linger is on.
 */
async function linuxSetup() {
	const f = await setup();
	f.env.XDG_CONFIG_HOME = undefined;
	f.env.TZ = undefined;
	await writeFile(
		join(f.bin, 'systemctl'),
		`#!/bin/sh
cd '${f.root}'
shift
printf '%s\\n' "$*" >> calls
if [ -f nobus ]; then
  echo 'Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined' >&2
  exit 1
fi
if [ -f "fail-$1" ]; then echo 'Access denied' >&2; exit 1; fi
case "$1" in
  restart) touch active ;;
  disable)
    if [ -f active ]; then rm active; else echo "Failed to disable unit: Unit file $3 does not exist." >&2; exit 1; fi ;;
  show)
    if [ -f active ]; then printf 'MainPID=4321\\nActiveState=active\\n'; else printf 'MainPID=0\\nActiveState=inactive\\n'; fi ;;
esac
`,
	);
	await writeFile(
		join(f.bin, 'loginctl'),
		`#!/bin/sh\nif [ -f '${f.root}/linger' ]; then echo yes; else echo no; fi\n`,
	);
	await chmod(join(f.bin, 'systemctl'), 0o755);
	await chmod(join(f.bin, 'loginctl'), 0o755);
	const entry = join(f.root, 'linux.ts');
	await writeFile(
		entry,
		`import { serviceCommand } from ${JSON.stringify(resolve(import.meta.dir, 'service.ts'))};
const words = process.argv.slice(2);
process.exitCode = await serviceCommand(words.filter((word) => word !== '--json'), words.includes('--json'), 'linux');
`,
	);
	const linux = async (...args: string[]) => {
		const child = Bun.spawn([process.execPath, entry, ...args], {
			cwd: f.root,
			env: f.env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	};
	return { ...f, linux };
}

test('Linux install writes the unit, enables it, and starts or replaces it', async () => {
	const f = await linuxSetup();
	f.env.TZ = 'Europe/Paris';
	const first = await f.linux('install', '--json');
	expect(first.code).toBe(0);
	const { label, unitPath, logs, linger, timeZone } = JSON.parse(first.stdout);
	expect(label).toMatch(/^com\.epicenter\.serve\.epicenter-[0-9a-f]{8}$/);
	const unit = `${label}.service`;
	expect(unitPath).toBe(join(f.root, '.config', 'systemd', 'user', unit));
	expect(logs).toBe(`journalctl --user -u ${unit}`);
	expect(linger).toBe(false);
	expect(timeZone).toBe('Europe/Paris');
	expect(await readFile(unitPath, 'utf8')).toBe(
		systemdUnit({
			program: f.program,
			folder: f.home,
			environment: { PATH: f.env.PATH!, TZ: 'Europe/Paris' },
		}),
	);
	const second = await f.linux('install', '--json');
	expect(second.code).toBe(0);
	const steps = ['daemon-reload', `enable ${unit}`, `restart ${unit}`];
	expect(await f.calls()).toEqual([...steps, ...steps]);
});

test('Linux install follows XDG_CONFIG_HOME and asks for linger and a time zone', async () => {
	const f = await linuxSetup();
	f.env.XDG_CONFIG_HOME = join(f.root, 'config');
	f.env.TZ = 'UTC';
	const installed = await f.linux('install');
	expect(installed.code).toBe(0);
	const [label, unitPath] = installed.stdout.split('\n');
	expect(unitPath).toBe(
		join(f.root, 'config', 'systemd', 'user', `${label}.service`),
	);
	expect(installed.stdout).toContain(
		`Logs: journalctl --user -u ${label}.service`,
	);
	expect(installed.stderr).toContain('Linger is off');
	expect(installed.stderr).toContain(
		`Run: loginctl enable-linger (or, if it asks for a password you do not have: sudo loginctl enable-linger ${userInfo().username})`,
	);
	expect(installed.stderr).toContain(
		'Apps record dates in UTC. If you live elsewhere, set your zone with sudo timedatectl set-timezone <Area/City>, or TZ in this shell, then run epicenter service install again.',
	);
	await writeFile(join(f.root, 'linger'), '');
	f.env.TZ = 'Europe/Paris';
	const again = await f.linux('install');
	expect(again.stderr).toBe('');
});

test('Linux install refuses when Git has no identity, before writing anything', async () => {
	const f = await linuxSetup();
	f.env.GIT_CONFIG_GLOBAL = '/dev/null';
	const result = await f.linux('install', '--json');
	expect(result.code).toBe(1);
	expect(JSON.parse(result.stdout).error.message).toContain(
		'Git does not know who you are',
	);
	expect(await f.calls()).toEqual([]);
});

test('Linux uninstall succeeds when the unit is not there; restart needs an install', async () => {
	const f = await linuxSetup();
	const uninstalled = await f.linux('uninstall', '--json');
	expect(uninstalled.code).toBe(0);
	expect(JSON.parse(uninstalled.stdout)).toMatchObject({ installed: false });
	const restarted = await f.linux('restart');
	expect(restarted.code).toBe(1);
	expect(restarted.stderr).toContain('is not installed');
	expect(await f.calls()).toEqual([
		expect.stringMatching(/^disable --now com\.epicenter\.serve\..+\.service$/),
		'daemon-reload',
	]);
});

test('Linux status reports running, stopped, and absent units, and linger', async () => {
	const f = await linuxSetup();
	const { label, unitPath } = JSON.parse(
		(await f.linux('install', '--json')).stdout,
	);
	const unit = `${label}.service`;
	const logs = `journalctl --user -u ${unit}`;
	const running = await f.linux('status', '--json');
	expect(JSON.parse(running.stdout)).toEqual({
		label,
		installed: true,
		running: true,
		pid: 4321,
		port: 4747,
		unitPath,
		logs,
		linger: false,
	});
	expect((await f.linux('restart', '--json')).code).toBe(0);
	await rm(join(f.root, 'active'));
	await writeFile(join(f.root, 'linger'), '');
	const stopped = await f.linux('status');
	expect(stopped.stdout).toBe(
		`${label}: stopped\nPort: 4747\nLogs: ${logs}\nLinger: on\n`,
	);
	const uninstalled = await f.linux('uninstall');
	expect(uninstalled.code).toBe(0);
	const absent = await f.linux('status', '--json');
	expect(JSON.parse(absent.stdout)).toMatchObject({
		installed: false,
		running: false,
	});
	expect(await f.calls()).toEqual([
		'daemon-reload',
		`enable ${unit}`,
		`restart ${unit}`,
		`show -p ActiveState,MainPID ${unit}`,
		`restart ${unit}`,
		`show -p ActiveState,MainPID ${unit}`,
		`disable --now ${unit}`,
		'daemon-reload',
	]);
});

test('Linux names the way in when systemctl cannot reach a user session', async () => {
	const f = await linuxSetup();
	await writeFile(join(f.root, 'nobus'), '');
	const result = await f.linux('install');
	expect(result.code).toBe(1);
	expect(result.stderr).toContain(
		'systemctl --user cannot reach your user session',
	);
	expect(result.stderr).toContain(
		`rather than through sudo or su; or run: sudo machinectl shell ${userInfo().username}@`,
	);
	await rm(join(f.root, 'nobus'));
	await writeFile(join(f.root, 'fail-restart'), '');
	const failed = await f.linux('install');
	expect(failed.code).toBe(1);
	expect(failed.stderr).toBe(
		'systemctl --user restart failed: Access denied\n',
	);
});
