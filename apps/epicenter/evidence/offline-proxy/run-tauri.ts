import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

// The Tauri gate over the same fixture as run.ts. Each phase is a fresh
// process of the `hosted_site_offline` example; the site's folder area and
// its WebKit store carry over between phases, as they would across launches.
const directory = import.meta.dir;
const scratch = join(directory, '.tmp');
const manifest = join(directory, '../../src-tauri/Cargo.toml');
const bun = process.execPath;
const gateRoot = join(scratch, 'tauri');
const salt = crypto.randomUUID();
rmSync(gateRoot, { recursive: true, force: true });
mkdirSync(join(gateRoot, 'data'), { recursive: true });
mkdirSync(join(gateRoot, 'library'), { recursive: true });
rmSync(join(scratch, 'recorded.json'), { force: true });
rmSync(join(scratch, 'foreign-requests.log'), { force: true });
for (const phase of ['online', 'offline', 'wrong-pin'])
	rmSync(join(scratch, `tauri-${phase}.json`), { force: true });

function certificate(name: string) {
	const result = Bun.spawnSync(
		[
			'openssl',
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			join(scratch, `${name}key.pem`),
			'-out',
			join(scratch, `${name}cert.pem`),
			'-days',
			'1',
			'-subj',
			'/CN=probe.epicenter.test',
			'-addext',
			'subjectAltName=DNS:probe.epicenter.test',
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

certificate('');
certificate('upstream-');

// `drained` settles once the server's stdout reaches end of file, so a log
// read after `stop` holds every line the server printed.
type Server = {
	process: Bun.Subprocess;
	log: string[];
	drained: Promise<void>;
};

function start(file: string, env: Record<string, string> = {}): Server {
	const child = Bun.spawn([bun, join(directory, file)], {
		cwd: directory,
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'inherit',
	});
	const log: string[] = [];
	const drained = (async () => {
		const decoder = new TextDecoder();
		let partial = '';
		for await (const chunk of child.stdout) {
			const text = decoder.decode(chunk, { stream: true });
			process.stdout.write(text);
			const lines = (partial + text).split('\n');
			partial = lines.pop() ?? '';
			log.push(...lines.filter(Boolean));
		}
		if (partial) log.push(partial);
	})();
	return { process: child, log, drained };
}

/** Stop the server and wait, bounded, until its whole log has been read. */
async function stop(server: Server) {
	server.process.kill();
	await server.process.exited;
	const timedOut = Symbol();
	const outcome = await Promise.race([
		server.drained.then(() => undefined),
		Bun.sleep(5_000).then(() => timedOut),
	]);
	if (outcome === timedOut)
		throw new Error('A fixture server log did not finish after it exited');
}

function listening(port: number) {
	return new Promise<boolean>((resolve) => {
		const socket = createConnection(port, '127.0.0.1');
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

async function waitForPort(port: number, server: Server) {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (server.process.exitCode !== null)
			throw new Error(`Server on ${port} exited before listening`);
		if (await listening(port)) return;
		await Bun.sleep(100);
	}
	throw new Error(`Server on ${port} did not start`);
}

const build = Bun.spawnSync(
	[
		'cargo',
		'build',
		'--manifest-path',
		manifest,
		'--example',
		'hosted_site_offline',
		'--features',
		'hosted-site-offline-gate',
	],
	{ stdout: 'inherit', stderr: 'inherit' },
);
if (build.exitCode !== 0) throw new Error('The gate example did not build');

// Asynchronous, so the event loop keeps reading the fixture servers' logs
// while the example runs.
async function gate(phase: 'online' | 'offline' | 'wrong-pin') {
	const child = Bun.spawn(
		[
			'cargo',
			'run',
			'--quiet',
			'--manifest-path',
			manifest,
			'--example',
			'hosted_site_offline',
			'--features',
			'hosted-site-offline-gate',
			'--',
			phase,
			scratch,
		],
		{
			env: {
				...process.env,
				EPICENTER_DATA_DIR: join(gateRoot, 'data'),
				EPICENTER_FOLDER_DIR: join(gateRoot, 'library'),
				GATE_STORE_SALT: salt,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const timer = setTimeout(() => child.kill(), 180_000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	const output = stdout + stderr;
	console.log(`\nTAURI ${phase.toUpperCase()}\n${output.trim()}`);
	const report = join(scratch, `tauri-${phase}.json`);
	if (exitCode !== 0 || !output.includes(`GATE ${phase} PASSED`))
		throw new Error(
			`${phase}: exit ${exitCode}; see ${existsSync(report) ? report : 'the output above'}`,
		);
	return JSON.parse(readFileSync(report, 'utf8'));
}

function served(server: Server, kind: 'RECORD' | 'REPLAY') {
	return server.log.filter((line) => line.startsWith(`${kind} `));
}

// A site navigation that WebKit attempted would reach the foreign page either
// directly, which `foreign.ts` logs, or as a tunnel the proxy refuses.
function assertNoRefusedTunnel(server: Server, phase: string) {
	const refused = server.log.filter((line) => line.startsWith('REFUSED '));
	if (refused.length > 0)
		throw new Error(`${phase}: the proxy refused ${refused.join(', ')}`);
}

const fixturePaths = ['/', '/app.js', '/worker.js'];

let upstream: Server | undefined;
let proxy: Server | undefined;
let foreign: Server | undefined;
try {
	foreign = start('foreign.ts');
	await waitForPort(38476, foreign);
	upstream = start('upstream.ts');
	proxy = start('proxy.ts');
	await waitForPort(38475, upstream);
	await waitForPort(38474, proxy);
	// Each proxy's log is asserted only after `stop` has read all of it.
	await gate('online');
	const online = proxy;
	proxy = undefined;
	await stop(online);
	await stop(upstream);
	upstream = undefined;
	const recorded = served(online, 'RECORD');
	for (const path of fixturePaths)
		if (!recorded.includes(`RECORD ${path} 200`))
			throw new Error(`Online: ${path} was not recorded`);
	assertNoRefusedTunnel(online, 'Online');
	console.log('ONLINE RECORDS:', recorded.join(', '));

	if (await listening(38475))
		throw new Error('The upstream is still listening');
	proxy = start('proxy.ts', { PROBE_OFFLINE: '1' });
	await waitForPort(38474, proxy);
	await gate('offline');
	const offline = proxy;
	proxy = undefined;
	await stop(offline);
	const replayed = served(offline, 'REPLAY');
	if (served(offline, 'RECORD').length > 0)
		throw new Error('Offline: the proxy recorded');
	for (const path of fixturePaths)
		if (replayed.filter((line) => line === `REPLAY ${path} 200`).length < 2)
			throw new Error(
				`Offline: ${path} was not replayed for the load and the reload`,
			);
	assertNoRefusedTunnel(offline, 'Offline');
	console.log('OFFLINE REPLAYS:', replayed.join(', '));

	proxy = start('proxy.ts', { PROBE_OFFLINE: '1' });
	await waitForPort(38474, proxy);
	await gate('wrong-pin');
	const wrongPin = proxy;
	proxy = undefined;
	await stop(wrongPin);
	if (
		served(wrongPin, 'REPLAY').length > 0 ||
		served(wrongPin, 'RECORD').length > 0
	)
		throw new Error('Wrong pin: the proxy served the page');
	assertNoRefusedTunnel(wrongPin, 'Wrong pin');

	const foreignServer = foreign;
	foreign = undefined;
	await stop(foreignServer);
	// Only the two controls, online and offline, load the foreign page.
	const foreignRequests = foreignServer.log.filter(
		(line) => line === 'FOREIGN REQUEST GET /foreign HTTP/1.1',
	);
	if (foreignRequests.length !== 2)
		throw new Error(
			`Foreign page requested ${foreignRequests.length} times, not 2`,
		);
	console.log('\nAll Tauri gate phases passed.');
} finally {
	if (proxy) await stop(proxy);
	if (upstream) await stop(upstream);
	if (foreign) await stop(foreign);
}
