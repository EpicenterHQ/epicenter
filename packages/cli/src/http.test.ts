/**
 * `serve`'s backup clock, in process: each tick does what `epicenter sync`
 * does for every app, pushing only when there is something to push. Tests
 * drive `tick()` directly, which runs after any backup already running; none
 * waits on the clock's 5 minutes.
 */
import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHttpServer } from './http.ts';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';

setDefaultTimeout(30_000);

// The Epicenter is chosen once per process, so every test here shares one.
const f = await fixture();
process.env.EPICENTER_ROOT = f.home;
afterAll(() => rm(f.root, { recursive: true, force: true }));

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	await rm(join(f.home, 'reading'), { recursive: true, force: true });
	await rm(join(f.root, 'remote.git'), { recursive: true, force: true });
});

/** Reading, backed up to a bare `origin` it has pushed to. */
async function reading() {
	const folder = await f.folder(join(f.home, 'reading'), readingApp);
	await mkdir(join(folder, 'data'));
	await f.run('sync', 'reading');
	const remote = join(f.root, 'remote.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(join(folder, 'data'), 'remote', 'add', 'origin', remote);
	await gitIn(join(folder, 'data'), 'push', '-q', '-u', 'origin', 'HEAD');
	return { folder, remote };
}

function serve() {
	const server = startHttpServer('127.0.0.1', 0);
	stops.push(server.stop);
	return server;
}

/** Everything `process.stderr` is given while `work` runs. */
async function stderrOf(work: () => Promise<unknown>) {
	const write = process.stderr.write;
	let written = '';
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await work();
	} finally {
		process.stderr.write = write;
	}
	return written;
}

test('serve backs up once when it starts: outside edits are snapshotted and pushed', async () => {
	const { folder, remote } = await reading();
	await writeFile(join(folder, 'data/notes.md'), 'by hand\n');
	const server = serve();
	// A tick waits for the backup serve started with, which left it nothing to do.
	const [after] = await server.tick();
	expect(after?.data).toMatchObject({ committed: null, pushed: false });
	expect(await gitIn(remote, 'log', '-1', '--format=%s')).toBe(
		'reading: changed outside epicenter',
	);
	expect(await gitIn(remote, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'notes.md',
	);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
});

test('a tick commits outside edits and pushes them, and pushes only when something is unpushed', async () => {
	const { folder, remote } = await reading();
	const server = serve();
	await server.tick();

	await writeFile(join(folder, 'data/notes.md'), 'by hand\n');
	const [pushed] = await server.tick();
	expect(pushed?.data).toMatchObject({
		committed: { subject: 'reading: changed outside epicenter', files: 1 },
		pushed: true,
		origin: { ahead: 0 },
	});
	expect(await gitIn(remote, 'rev-parse', 'HEAD')).toBe(
		await gitIn(join(folder, 'data'), 'rev-parse', 'HEAD'),
	);

	// Nothing pending or unpushed: no push, so an origin that is gone is never reached.
	await gitIn(
		join(folder, 'data'),
		'remote',
		'set-url',
		'origin',
		join(f.root, 'gone.git'),
	);
	const [idle] = await server.tick();
	expect(idle?.data).toMatchObject({ committed: null, pushed: false });
	expect(idle?.data?.error).toBeUndefined();

	// A commit made by hand is unpushed, so the next tick pushes it.
	await gitIn(join(folder, 'data'), 'remote', 'set-url', 'origin', remote);
	await writeFile(join(folder, 'data/agent.md'), 'by an agent\n');
	await gitIn(join(folder, 'data'), 'add', 'agent.md');
	await gitIn(
		join(folder, 'data'),
		'commit',
		'-q',
		'-m',
		'reading: an agent added a page',
	);
	const [unpushed] = await server.tick();
	expect(unpushed?.data).toMatchObject({ committed: null, pushed: true });
	expect(await gitIn(remote, 'log', '-1', '--format=%s')).toBe(
		'reading: an agent added a page',
	);
});

test('a tick logs an unchanged failure once, and again when it changes', async () => {
	const { folder } = await reading();
	const server = serve();
	await server.tick();
	await writeFile(join(folder, 'data/.gitignore'), '');
	await writeFile(join(folder, 'data/token.local'), 'secret\n');
	const logged = await stderrOf(async () => {
		await server.tick();
		await server.tick();
		await rm(join(folder, 'data/token.local'));
		await writeFile(join(folder, 'data/device.local'), 'this computer\n');
		await server.tick();
		await server.tick();
	});
	expect(logged).toBe(
		[
			'reading/data: token.local would be committed; add *.local and *.local.* to reading/data/.gitignore',
			'reading/data: device.local would be committed; add *.local and *.local.* to reading/data/.gitignore',
			'',
		].join('\n'),
	);
	expect(await gitIn(join(folder, 'data'), 'rev-list', '--count', 'HEAD')).toBe(
		'1',
	);
});
