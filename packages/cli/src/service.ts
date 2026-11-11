/** Install and inspect the macOS LaunchAgent for one Epicenter (ADR-0878). */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { COMPILED } from './child.ts';
import { misuse, parseWords } from './commands.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { type EpicenterRoot, epicenterRoot } from './root.ts';

type LaunchctlResult = { code: number; stdout: string; stderr: string };
type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

type ServiceDependencies = {
	launchctl?: LaunchctlRunner;
	platform?: string;
	home?: string;
	root?: EpicenterRoot;
	uid?: number;
	which?: (name: string) => string | null;
	compiled?: boolean;
	execPath?: string;
};

async function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
	const child = Bun.spawn(['launchctl', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** The job must run an installed command, never a source file in this checkout. */
function installedEpicenter({
	which,
	compiled,
	execPath,
}: Required<
	Pick<ServiceDependencies, 'which' | 'compiled' | 'execPath'>
>): string {
	const found = compiled ? execPath : which('epicenter');
	if (!found)
		throw new Error(
			'No installed epicenter command found on PATH. Install @epicenter/cli first.',
		);
	const path = realpathSync(found);
	for (let folder = dirname(path); ; folder = dirname(folder)) {
		if (
			existsSync(join(folder, '.git')) &&
			existsSync(join(folder, 'packages', 'cli', 'src', 'bin.ts'))
		)
			throw new Error(
				`The epicenter command at ${path} is inside a monorepo checkout. Install @epicenter/cli first.`,
			);
		if (dirname(folder) === folder) break;
	}
	return path;
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

function plist(
	executable: string,
	folder: string,
	label: string,
	log: string,
	path: string,
) {
	const element = (key: string, value: string) =>
		`\t<key>${key}</key>\n\t<string>${xml(value)}</string>\n`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${element('Label', label)}\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(executable)}</string>
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

const isNotLoaded = ({ code, stdout, stderr }: LaunchctlResult) =>
	code !== 0 &&
	/Could not find service|service not found|No such process|not loaded|Could not find specified service/i.test(
		`${stdout}\n${stderr}`,
	);

function failure(message: string, json: boolean): number {
	if (json) writeJson({ error: { message } });
	else writeErr(message);
	return 1;
}

/** One command for all four job operations; the runner is replaceable in tests. */
export async function serviceCommand(
	words: string[],
	json: boolean,
	dependencies: ServiceDependencies = {},
): Promise<number> {
	const given = parseWords(words, {}, [1, 1]);
	const action = given?.positionals[0];
	if (
		!action ||
		!['install', 'uninstall', 'restart', 'status'].includes(action)
	)
		return fail(misuse('service'), json);
	if ((dependencies.platform ?? process.platform) !== 'darwin')
		return failure('epicenter service is macOS-only for now.', json);

	const root = dependencies.root ?? epicenterRoot();
	const home = dependencies.home ?? homedir();
	const realFolder = realpathSync(root.folder);
	const slug = basename(root.folder)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-');
	const hash = createHash('sha256')
		.update(realFolder)
		.digest('hex')
		.slice(0, 8);
	const label = `com.epicenter.serve.${slug}-${hash}`;
	const domain = `gui/${dependencies.uid ?? userInfo().uid}`;
	const job = `${domain}/${label}`;
	const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
	const logPath = join(home, 'Library', 'Logs', 'Epicenter', `${label}.log`);
	const launchctl = dependencies.launchctl ?? runLaunchctl;
	const call = async (args: string[], allowNotLoaded = false) => {
		const result = await launchctl(args);
		if (result.code !== 0 && !(allowNotLoaded && isNotLoaded(result)))
			throw new Error(
				`launchctl ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
			);
		return result;
	};

	try {
		switch (action) {
			case 'install': {
				const which = dependencies.which ?? ((name: string) => Bun.which(name));
				const compiled = dependencies.compiled ?? COMPILED;
				const executable = installedEpicenter({
					which,
					compiled,
					execPath: dependencies.execPath ?? process.execPath,
				});
				// An installed script starts with `env bun`, so launchd's PATH
				// needs Bun's folder unless the command is the compiled binary.
				const paths = (
					compiled ? ['git', 'git-lfs'] : ['bun', 'git', 'git-lfs']
				)
					.map(which)
					.filter((path): path is string => path !== null)
					.map(dirname);
				const path = [
					...new Set([...paths, '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
				].join(':');
				await mkdir(dirname(plistPath), { recursive: true });
				await mkdir(dirname(logPath), { recursive: true });
				await writeFile(
					plistPath,
					plist(executable, root.folder, label, logPath, path),
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
				const printed = installed
					? await call(['print', job], true)
					: undefined;
				const running =
					printed?.code === 0 &&
					/^\s*state = running\s*$/m.test(printed.stdout);
				const pid = running
					? Number(/^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1]) ||
						undefined
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
	} catch (error) {
		return failure(
			error instanceof Error ? error.message : String(error),
			json,
		);
	}
	return 1;
}
