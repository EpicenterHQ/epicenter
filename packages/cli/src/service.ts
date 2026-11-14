/**
 * Install and inspect the job that keeps `serve` running for one Epicenter
 * (ADR-0878): a LaunchAgent on macOS, a systemd user unit on Linux.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { COMPILED, misuse, parseWords } from './commands.ts';
import { identityProblem } from './git.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { type EpicenterRoot, epicenterRoot } from './root.ts';

type Ran = { code: number; stdout: string; stderr: string };

/** Run `program ...args` with this process's environment as it is now. */
async function run(program: string, args: string[]): Promise<Ran> {
	let child: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
	try {
		child = Bun.spawn([program, ...args], {
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			throw new Error(`${program} is not on PATH.`);
		throw error;
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

const xml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(character) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&apos;',
			})[character] ?? character,
	);

export function launchAgent({
	label,
	program,
	folder,
	path,
	log,
}: {
	label: string;
	program: string;
	folder: string;
	path: string;
	log: string;
}): string {
	const element = (key: string, value: string) =>
		`\t<key>${key}</key>\n\t<string>${xml(value)}</string>\n`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${element('Label', label)}\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(program)}</string>
\t\t<string>serve</string>
\t</array>
${element('WorkingDirectory', folder)}\t<key>RunAtLoad</key><true/>
\t<key>KeepAlive</key><true/>
\t<key>EnvironmentVariables</key>
\t<dict>
${element('PATH', path)}\t</dict>
${element('StandardOutPath', log)}${element('StandardErrorPath', log)}</dict>
</plist>
`;
}

/**
 * A systemd user unit that runs `program serve` in `folder` with
 * `environment`, restarting it whenever it exits, forever. systemd expands
 * `%` specifiers in every value, so `%` is written `%%`; `ExecStart=` and
 * `Environment=` unquote and C-unescape, so a `\` or `"` inside quotes is
 * escaped; `ExecStart=` also expands `$`, written `$$`. `WorkingDirectory=`
 * is taken as it is. A unit file is lines, so a value with a control
 * character throws.
 */
export function systemdUnit({
	program,
	folder,
	environment,
}: {
	program: string;
	folder: string;
	environment: Record<string, string>;
}): string {
	for (const value of [program, folder, ...Object.values(environment)])
		if ([...value].some((c) => c.charCodeAt(0) < 0x20 || c === '\x7f'))
			throw new Error(
				`${JSON.stringify(value)} has a control character, which a systemd unit cannot hold.`,
			);
	const specifiers = (value: string) => value.replace(/%/g, '%%');
	const quoted = (value: string) =>
		`"${specifiers(value).replace(/[\\"]/g, (character) => `\\${character}`)}"`;
	return `[Unit]
Description=epicenter serve in ${specifiers(folder)}
StartLimitIntervalSec=0

[Service]
ExecStart=${quoted(program).replace(/\$/g, '$$$$')} serve
WorkingDirectory=${specifiers(folder)}
${Object.entries(environment)
	.map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}\n`)
	.join('')}Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function failure(message: string, json: boolean): number {
	if (json) writeJson({ error: { message } });
	else writeErr(message);
	return 1;
}

/** What every platform's job is made from. */
type Job = {
	root: EpicenterRoot;
	/** `com.epicenter.serve.<folder name>-<hash of its real path>`, one per Epicenter. */
	label: string;
	json: boolean;
};

/**
 * What the job runs and with which `PATH`, checked before anything is
 * written: the `epicenter` on `PATH` or this compiled binary, and a Git that
 * can commit with no shell around it.
 */
async function jobProgram() {
	const path = process.env.PATH;
	if (path === undefined)
		throw new Error('PATH is unset. Set PATH before installing the service.');
	const found = COMPILED
		? process.execPath
		: Bun.which('epicenter', { PATH: path });
	if (!found)
		throw new Error(
			'No epicenter command found on PATH. Install @epicenter/cli first.',
		);
	const problem = await identityProblem({ configOnly: true });
	if (problem) throw new Error(problem);
	return { program: resolve(found), path };
}

/** One command for all four job operations. */
export async function serviceCommand(
	words: string[],
	json: boolean,
	platform = process.platform,
): Promise<number> {
	const given = parseWords(words, {}, [1, 1]);
	const action = given?.positionals[0];
	if (
		action !== 'install' &&
		action !== 'uninstall' &&
		action !== 'restart' &&
		action !== 'status'
	)
		return fail(misuse('service'), json);
	if (platform !== 'darwin' && platform !== 'linux')
		return failure('epicenter service runs on macOS and Linux.', json);

	const root = epicenterRoot();
	const slug = basename(root.folder)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-');
	const hash = createHash('sha256')
		.update(realpathSync(root.folder))
		.digest('hex')
		.slice(0, 8);
	const job: Job = { root, label: `com.epicenter.serve.${slug}-${hash}`, json };
	try {
		return platform === 'darwin'
			? await launchAgentCommand(action, job)
			: await systemdCommand(action, job);
	} catch (error) {
		return failure(
			error instanceof Error ? error.message : String(error),
			json,
		);
	}
}

const isNotLoaded = ({ code, stdout, stderr }: Ran) =>
	code !== 0 &&
	/Could not find service|service not found|No such process|not loaded|Could not find specified service/i.test(
		`${stdout}\n${stderr}`,
	);

async function launchAgentCommand(
	action: 'install' | 'uninstall' | 'restart' | 'status',
	{ root, label, json }: Job,
): Promise<number> {
	const home = homedir();
	const domain = `gui/${userInfo().uid}`;
	const job = `${domain}/${label}`;
	const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
	const logPath = join(home, 'Library', 'Logs', 'Epicenter', `${label}.log`);
	const call = async (args: string[], allowNotLoaded = false) => {
		const result = await run('launchctl', args);
		if (result.code !== 0 && !(allowNotLoaded && isNotLoaded(result)))
			throw new Error(
				`launchctl ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
			);
		return result;
	};
	switch (action) {
		case 'install': {
			const { program, path } = await jobProgram();
			await mkdir(dirname(plistPath), { recursive: true });
			await mkdir(dirname(logPath), { recursive: true });
			await writeFile(
				plistPath,
				launchAgent({
					label,
					program,
					folder: root.folder,
					path,
					log: logPath,
				}),
			);
			const loaded = await call(['print', job], true);
			if (loaded.code === 0) await call(['bootout', job], true);
			await call(['bootstrap', domain, plistPath]);
			const result = { label, plistPath, logPath };
			if (json) writeJson(result);
			else writeOut(`${label}\n${plistPath}\n${logPath}`);
			return 0;
		}
		case 'uninstall': {
			await call(['bootout', job], true);
			await rm(plistPath, { force: true });
			if (json) writeJson({ label, installed: false });
			else writeOut(`Uninstalled ${label}`);
			return 0;
		}
		case 'restart': {
			if (!existsSync(plistPath))
				return failure(
					`${label} is not installed. Run: epicenter service install`,
					json,
				);
			await call(['kickstart', '-k', job]);
			if (json) writeJson({ label, restarted: true });
			else writeOut(`Restarted ${label}`);
			return 0;
		}
		case 'status': {
			const installed = existsSync(plistPath);
			const printed = installed ? await call(['print', job], true) : undefined;
			const running =
				printed?.code === 0 && /^\s*state = running\s*$/m.test(printed.stdout);
			const pid = running
				? Number(/^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1]) || undefined
				: undefined;
			const result = {
				label,
				installed,
				running,
				...(pid === undefined ? {} : { pid }),
				port: root.port,
				logPath,
			};
			if (json) writeJson(result);
			else
				writeOut(
					`${label}: ${!installed ? 'not installed' : running ? `running${pid ? ` (pid ${pid})` : ''}` : 'stopped'}\nPort: ${root.port}\nLog: ${logPath}`,
				);
			return 0;
		}
	}
}

/** `systemctl --user` cannot reach the person's service manager, as under `sudo su - <user>`. */
const NO_USER_BUS =
	/Failed to connect to (user scope )?bus|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/i;

/** `systemctl` saying the unit it was asked to disable is not there. */
const NO_UNIT = /does not exist|not loaded|not found/i;

/**
 * Whether systemd starts this person's user units at boot and keeps them
 * after logout; `false` when `loginctl` cannot say.
 */
async function lingers(user: string) {
	try {
		const shown = await run('loginctl', [
			'show-user',
			user,
			'-p',
			'Linger',
			'--value',
		]);
		return shown.code === 0 && shown.stdout.trim() === 'yes';
	} catch {
		return false;
	}
}

async function systemdCommand(
	action: 'install' | 'uninstall' | 'restart' | 'status',
	{ root, label, json }: Job,
): Promise<number> {
	const user = userInfo().username;
	const configHome = process.env.XDG_CONFIG_HOME?.startsWith('/')
		? process.env.XDG_CONFIG_HOME
		: join(homedir(), '.config');
	const unit = `${label}.service`;
	const unitPath = join(configHome, 'systemd', 'user', unit);
	const logs = `journalctl --user -u ${unit}`;
	const lingerAdvice = `Linger is off, so serve stops when you log out and starts after a reboot only once you log in.\nRun: loginctl enable-linger (or, if it asks for a password you do not have: sudo loginctl enable-linger ${user})`;
	const call = async (args: string[], allowNoUnit = false) => {
		let result: Ran;
		try {
			result = await run('systemctl', ['--user', ...args]);
		} catch {
			throw new Error(
				'systemctl is not on PATH. epicenter service needs systemd on Linux.',
			);
		}
		const said = result.stderr.trim() || result.stdout.trim();
		if (result.code === 0 || (allowNoUnit && NO_UNIT.test(said))) return result;
		if (NO_USER_BUS.test(said))
			throw new Error(
				`systemctl --user cannot reach your user session (${said.split('\n')[0]}). Log in as ${user} directly, such as over SSH, rather than through sudo or su; or run: sudo machinectl shell ${user}@`,
			);
		throw new Error(
			`systemctl --user ${args[0]} failed: ${said || `exit ${result.code}`}`,
		);
	};
	switch (action) {
		case 'install': {
			const { program, path } = await jobProgram();
			const tz = process.env.TZ;
			await mkdir(dirname(unitPath), { recursive: true });
			await writeFile(
				unitPath,
				systemdUnit({
					program,
					folder: root.folder,
					environment: { PATH: path, ...(tz ? { TZ: tz } : {}) },
				}),
			);
			await call(['daemon-reload']);
			await call(['enable', unit]);
			// Starts the job, or replaces one an earlier install left running.
			await call(['restart', unit]);
			const linger = await lingers(user);
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			if (json) writeJson({ label, unitPath, logs, linger, timeZone });
			else {
				writeOut(
					`${label}\n${unitPath}\nLogs: ${logs}\nTime zone: ${timeZone}`,
				);
				if (!linger) writeErr(lingerAdvice);
				if (/^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu)$/.test(timeZone))
					writeErr(
						`Apps record dates in ${timeZone}. If you live elsewhere, set your zone with sudo timedatectl set-timezone <Area/City>, or TZ in this shell, then run epicenter service install again.`,
					);
			}
			return 0;
		}
		case 'uninstall': {
			await call(['disable', '--now', unit], true);
			await rm(unitPath, { force: true });
			await call(['daemon-reload']);
			if (json) writeJson({ label, installed: false });
			else writeOut(`Uninstalled ${label}`);
			return 0;
		}
		case 'restart': {
			if (!existsSync(unitPath))
				return failure(
					`${label} is not installed. Run: epicenter service install`,
					json,
				);
			await call(['restart', unit]);
			if (json) writeJson({ label, restarted: true });
			else writeOut(`Restarted ${label}`);
			return 0;
		}
		case 'status': {
			const installed = existsSync(unitPath);
			const shown = installed
				? (await call(['show', '-p', 'ActiveState,MainPID', unit])).stdout
				: '';
			const property = (name: string) =>
				new RegExp(`^${name}=(.*)$`, 'm').exec(shown)?.[1];
			const running = property('ActiveState') === 'active';
			const pid = running
				? Number(property('MainPID')) || undefined
				: undefined;
			const linger = await lingers(user);
			const result = {
				label,
				installed,
				running,
				...(pid === undefined ? {} : { pid }),
				port: root.port,
				unitPath,
				logs,
				linger,
			};
			if (json) writeJson(result);
			else {
				writeOut(
					`${label}: ${!installed ? 'not installed' : running ? `running${pid ? ` (pid ${pid})` : ''}` : 'stopped'}\nPort: ${root.port}\nLogs: ${logs}\nLinger: ${linger ? 'on' : 'off'}`,
				);
				if (installed && !linger) writeErr(lingerAdvice);
			}
			return 0;
		}
	}
}
