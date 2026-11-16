#!/usr/bin/env bun
/** Install release downloads into an isolated home, then copy and use a committed writing app. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import manifest from '../package.json' with { type: 'json' };

const [assets, source, downloadBase] = Bun.argv.slice(2);
if (!assets || !source)
	throw new Error(
		'Usage: bun scripts/smoke-release.ts <asset directory> <committed app source> [public download URL]',
	);
const directory = resolve(assets);
const home = await mkdtemp(join(tmpdir(), 'epicenter-onboarding-'));
const env: Record<string, string | undefined> = {
	...process.env,
	HOME: home,
	PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
	XDG_DATA_HOME: join(home, '.local/share'),
	EPICENTER_ROOT: undefined,
	EPICENTER_INSTALL_DIR: join(home, '.local/bin'),
};
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
env.GIT_CONFIG_NOSYSTEM = '1';
env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
const releasePath = `/releases/download/epicenter-cli-v${manifest.version}/`;
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		if (!path.startsWith(releasePath))
			return new Response('Not found', { status: 404 });
		const name = path.slice(releasePath.length);
		if (
			!/^(install\.sh|epicenter-(darwin|linux)-(arm64|x64)(\.sha256)?)$/.test(
				name,
			)
		)
			return new Response('Not found', { status: 404 });
		return new Response(Bun.file(join(directory, name)));
	},
});
const localBase = new URL(releasePath, server.url).href;
// The published installer must find its assets using the URL it ships with.
env.EPICENTER_DOWNLOAD_BASE = downloadBase ? undefined : localBase;
env.EPICENTER_INSTALLER_URL = new URL(
	'install.sh',
	`${(downloadBase ?? localBase).replace(/\/$/, '')}/`,
).href;
const folder = join(home, 'Epicenter');
const executable = join(home, '.local/bin/epicenter');
let serving: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;

/** Read a successful action answer from either release in the reader-first rollout. */
function okData(answer: unknown): unknown {
	const result =
		answer && typeof answer === 'object' && 'result' in answer
			? answer.result
			: answer;
	if (
		!result ||
		typeof result !== 'object' ||
		!('error' in result) ||
		result.error !== null ||
		!('data' in result)
	)
		throw new Error('Expected a successful action answer');
	return result.data;
}

async function run(args: string[], cwd = home) {
	const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(`${args[0]}: exit ${code}\n${stdout}${stderr}`);
	return stdout;
}

try {
	if (Bun.which('bun', { PATH: env.PATH }))
		throw new Error('Bun is on the trial PATH');
	await run(['sh', '-c', 'curl -fsSL "$EPICENTER_INSTALLER_URL" | sh']);
	await run([executable, '--version']);
	await run(['git', 'config', '--global', 'user.name', 'Developer Trial']);
	await run([
		'git',
		'config',
		'--global',
		'user.email',
		'developer@example.test',
	]);
	await run(['git', 'config', '--global', 'commit.gpgsign', 'false']);
	await run([executable, 'init', folder, '--port', '0']);
	await run([executable, 'new', 'writing', '--from', source], folder);
	const provenance = await readFile(
		join(folder, 'apps/writing/code/SOURCE.md'),
		'utf8',
	);
	if (!/Source-Commit: [a-f0-9]{40}/.test(provenance))
		throw new Error('Missing source provenance');
	const answer = JSON.parse(
		await run(
			[
				executable,
				'writing',
				'add',
				JSON.stringify({
					body: 'A thought saved during my first writing session.',
					source: 'My notebook',
					project: 'Essay',
				}),
				'--json',
			],
			folder,
		),
	);
	const added = okData(answer);
	if (
		!added ||
		typeof added !== 'object' ||
		!('path' in added) ||
		typeof added.path !== 'string'
	)
		throw new Error('writing add did not return the saved path');
	const record = join(folder, 'apps/writing', added.path);
	const before = await readFile(record, 'utf8');
	await run(['sh', '-c', 'curl -fsSL "$EPICENTER_INSTALLER_URL" | sh']);
	if ((await readFile(record, 'utf8')) !== before)
		throw new Error('Reinstall changed a note');
	await run([executable, 'build', 'writing'], folder);
	serving = Bun.spawn([executable, 'serve'], {
		cwd: folder,
		env,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'pipe',
	});
	const ready = Promise.withResolvers<string>();
	const child = serving;
	void (async () => {
		let output = '';
		const reader = child.stderr.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			output += new TextDecoder().decode(value);
			const base = /Serving your apps at (http:\/\/127\.0\.0\.1:\d+)\./.exec(
				output,
			)?.[1];
			if (base) ready.resolve(base);
		}
		ready.reject(new Error(`Server stopped: ${output}`));
	})();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const base = await Promise.race([
		ready.promise,
		new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error('Server startup timed out')),
				20_000,
			);
		}),
	]).finally(() => clearTimeout(timeout));
	const page = await fetch(`${base}/writing/`);
	if (!page.ok || !(await page.text()).includes('Writing inbox'))
		throw new Error('Writing UI did not load');
	const client = new Client({ name: 'release-onboarding-trial', version: '1' });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${base}/`)),
		);
		const found = await client.callTool({
			name: 'writing_search',
			arguments: { query: 'first writing session' },
		});
		const notes = okData(found.structuredContent);
		if (
			found.isError ||
			!Array.isArray(notes) ||
			!notes.some(
				(note) => note?.source === 'My notebook' && note.path === added.path,
			)
		)
			throw new Error('MCP did not find the captured note with its source');
	} finally {
		await client.close();
	}
	console.log(
		'Passed: HTTP install, Git source copy, capture, reinstall, UI build, and MCP search without Bun on PATH.',
	);
} finally {
	if (serving) {
		serving.kill('SIGTERM');
		await serving.exited;
	}
	server.stop(true);
	await rm(home, { recursive: true, force: true });
}
