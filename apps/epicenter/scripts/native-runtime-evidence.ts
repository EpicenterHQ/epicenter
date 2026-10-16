/**
 * Twenty actual Tauri restarts with production Bun launch/shutdown and
 * admitted-window paths. Each restart is a granted restart finished by the
 * `relaunch` frame, so it runs `request_restart`; every exit must reach the
 * Folder plugin's shutdown. Bun's own preparation is covered by the
 * controlled port and authority tests. Uses a unique native identity and
 * temporary App data. No real account is read. Run from the repository root
 * with Bun.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = new URL('../../../', import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), 'epicenter-runtime-evidence-'));
const identifier = `so.epicenter.evidence.${crypto.randomUUID()}`;
const binary = resolve(
	repo,
	'apps/epicenter/src-tauri/target/debug/examples/runtime_lifetime_evidence',
);
type Event = {
	event: string;
	pid?: number;
	cycle?: number;
	error?: string;
	sidecarDead?: boolean;
	folderFenced?: boolean;
	restartRequested?: boolean;
	passed?: boolean;
	code?: number | null;
	prevented?: boolean;
};
let events: Event[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
async function readEvents() {
	const contents = await readFile(join(root, 'events.jsonl'), 'utf8').catch(
		() => '',
	);
	// The producer can be halfway through its final append while we read.
	events = contents
		.slice(0, contents.lastIndexOf('\n') + 1)
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const failure = events.find((event) => event.event === 'failure');
	if (failure) throw new Error(failure.error);
}
const named = (name: string) => events.filter((event) => event.event === name);
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
try {
	const bundle = join(root, 'data/apps/so.epicenter.runtimeevidence/bundle');
	await mkdir(bundle, { recursive: true });
	await writeFile(join(root, 'identifier'), identifier);
	await writeFile(
		join(root, 'website-store'),
		crypto.getRandomValues(new Uint8Array(16)),
	);
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { data() {} },
	});
	const port = listener.port;
	listener.stop(true);
	await writeFile(join(root, 'port'), String(port));
	await writeFile(
		join(bundle, 'manifest.json'),
		JSON.stringify({
			id: 'so.epicenter.runtimeevidence',
			title: 'Runtime evidence',
			version: '1',
		}),
	);
	const built = await Bun.build({
		entrypoints: [
			join(repo, 'apps/epicenter/evidence/runtime-lifetime/main.ts'),
		],
		outdir: bundle,
		target: 'browser',
		conditions: ['browser'],
		naming: 'main.js',
	});
	if (!built.success)
		throw new AggregateError(built.logs, 'Evidence fixture build failed');
	await writeFile(
		join(bundle, 'index.html'),
		'<!doctype html><html><body>Runtime lifetime evidence<script type="module" src="./main.js"></script></body></html>',
	);
	const build = Bun.spawn(
		[
			'cargo',
			'build',
			'--manifest-path',
			'apps/epicenter/src-tauri/Cargo.toml',
			'--features',
			'runtime-evidence',
			'--example',
			'runtime_lifetime_evidence',
		],
		{ cwd: repo, stdout: 'inherit', stderr: 'inherit' },
	);
	if (await build.exited) throw new Error('Native evidence build failed');
	child = Bun.spawn([binary], {
		cwd: repo,
		env: { ...process.env, EPICENTER_RUNTIME_EVIDENCE_ROOT: root },
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const deadline = Date.now() + 180_000;
	for (;;) {
		await Bun.sleep(100);
		await readEvents();
		if (named('shutdown').length === 21) break;
		if (Date.now() > deadline)
			throw new Error(
				`Native restart probe timed out: ${JSON.stringify(events.at(-1))}`,
			);
	}
	const chainExit = await child.exited;
	const hosts = named('host');
	const sidecars = named('sidecar');
	const documents = named('document');
	if (
		hosts.length !== 21 ||
		sidecars.length !== 21 ||
		documents.length !== 41 ||
		new Set(hosts.map((event) => event.pid)).size !== 21 ||
		!events.some((event) => event.event === 'passed')
	)
		throw new Error('Missing restart evidence');
	for (const event of [...hosts, ...sidecars])
		if (event.pid && alive(event.pid))
			throw new Error(`Probe process ${event.pid} survived`);
	const shutdowns = named('shutdown');
	if (!shutdowns.every((event) => event.folderFenced))
		throw new Error('An exit did not reach the Folder plugin shutdown');
	if (shutdowns.filter((event) => event.restartRequested).length !== 20)
		throw new Error('Not every restart went through the granted relaunch');
	// The last process exits with a code, which no window's closing holds.
	const lastRequests = named('exit-requested').filter(
		(event) => event.cycle === 20,
	);
	if (
		chainExit !== 0 ||
		lastRequests.length !== 1 ||
		lastRequests[0]?.code !== 0 ||
		lastRequests[0]?.prevented !== false
	)
		throw new Error(
			`The last exit is wrong: exit ${chainExit}, ${JSON.stringify(lastRequests)}`,
		);
	console.log(
		'PASS: 20 actual native restarts through granted relaunch and request_restart, 20 immediate admitted-window reopens, all committed App markers survived, every exit fenced the Folder plugin, all 21 native hosts and Bun sidecars terminated.',
	);
} finally {
	let profileRemoved = true;
	for (const event of events)
		if (event.pid && alive(event.pid)) process.kill(event.pid, 'SIGKILL');
	if (child && child.exitCode === null && child.signalCode === null)
		child.kill('SIGKILL');
	await child?.exited;
	if (child && process.platform === 'darwin') {
		const cleanup = Bun.spawn([binary], {
			cwd: repo,
			env: {
				...process.env,
				EPICENTER_RUNTIME_EVIDENCE_ROOT: root,
				EPICENTER_RUNTIME_EVIDENCE_CLEANUP: '1',
			},
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const timeout = setTimeout(() => cleanup.kill('SIGKILL'), 10_000);
		try {
			if (await cleanup.exited) {
				profileRemoved = false;
				process.exitCode = 1;
				console.error(
					`Failed to remove isolated WebKit profile. Evidence root: ${root}`,
				);
			}
		} finally {
			clearTimeout(timeout);
		}
	}
	if (profileRemoved) await rm(root, { recursive: true, force: true });
	if (process.platform === 'darwin')
		for (const directory of ['WebKit', 'Caches', 'Logs', 'Application Support'])
			await rm(join(homedir(), 'Library', directory, identifier), {
				recursive: true,
				force: true,
			});
}
