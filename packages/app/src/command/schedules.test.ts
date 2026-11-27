import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Listing } from '../call.ts';

const cli = new URL('./bin.ts', import.meta.url).pathname;
const app = import.meta.resolve('../index.ts');
const pending: Array<{
	child: ReturnType<typeof Bun.spawn>;
	stderr: Promise<string>;
}> = [];
const folders: string[] = [];
const date = '2026-11-26';
const zone = 'America/Los_Angeles';

afterEach(async () => {
	for (const { child, stderr } of pending.splice(0)) {
		if (child.exitCode === null) child.kill('SIGKILL');
		await child.exited;
		await stderr;
	}
	for (const folder of folders.splice(0))
		await rm(folder, { recursive: true, force: true });
});

async function waitFor<T>(
	read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(15);
	}
	throw new Error(
		'The scheduled-action fixture did not reach the expected state',
	);
}

async function fixture() {
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-schedule-'));
	folders.push(folder);
	const clock = join(folder, 'clock.txt');
	const preload = join(folder, 'clock.ts');
	const legacyState = join(folder, '.epicenter/schedules');
	const invocations = join(folder, 'invocations.txt');
	const marker = join(folder, 'imported.txt');
	const env = { ...process.env, TZ: zone };
	await writeFile(
		preload,
		`
		import { readFileSync } from 'node:fs';
		const RealDate = Date;
		const time = () => RealDate.parse(readFileSync(${JSON.stringify(clock)}, 'utf8'));
		globalThis.Date = class extends RealDate {
			constructor(...args) { super(...(args.length ? args : [time()])); }
			static now() { return time(); }
		};
		const arm = globalThis.setTimeout;
		globalThis.setTimeout = (callback, delay, ...args) => arm(callback, Math.min(delay, 20), ...args);
	`,
	);
	await writeFile(
		join(folder, 'epicenter.ts'),
		`
		import { appendFileSync } from 'node:fs';
		import { defineAction, defineData, defineEpicenter, field, Ok } from ${JSON.stringify(app)};
		appendFileSync(${JSON.stringify(marker)}, 'imported\\n');
		const data = defineData(import.meta.dir, {
			checks: { description: 'A scheduled check', fields: { recheck: field.boolean() } },
		});
		const daily = defineAction({
			description: 'Write a flight check',
			input: { recheck: field.boolean({ optional: true }) },
			async run({ recheck = false }) {
				appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ recheck }) + '\\n');
				if (process.env.DAILY_THROWS) throw Error('fixture action failure');
				if (process.env.HOLD_DAILY) await new Promise(() => {});
				const result = await data.checks.create(recheck ? 'manual' : 'scheduled', { recheck, body: 'Fixture flight check' });
				return result.error ? result : Ok({ state: 'unfinished' });
			},
		});
		export default defineEpicenter({
			apps: { flights: { description: 'Flights', actions: { daily } } },
			schedules: { 'morning-flights': { cron: '0 8 * * *', action: ['flights', 'daily'], input: {} } },
		});
	`,
	);
	async function setTime(time: string, day = date, offset = '-08:00') {
		await writeFile(`${clock}.new`, `${day}T${time}${offset}`);
		await rename(`${clock}.new`, clock);
	}
	async function usePort() {
		const holder = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(),
		});
		const port = holder.port;
		await holder.stop(true);
		await writeFile(
			join(folder, 'package.json'),
			JSON.stringify({ epicenter: { port } }),
		);
		return `http://127.0.0.1:${port}/actions/`;
	}
	function launch({ hold = false, fails = false, cwd = folder } = {}) {
		const child = Bun.spawn(
			[process.execPath, '--preload', preload, cli, 'serve'],
			{
				cwd,
				env: {
					...env,
					HOLD_DAILY: hold ? '1' : '',
					DAILY_THROWS: fails ? '1' : '',
				},
				stdout: 'ignore',
				stderr: 'pipe',
			},
		);
		const stderr = child.stderr.text();
		pending.push({ child, stderr });
		return { child, stderr };
	}
	async function list(url: string) {
		return waitFor(async () => {
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(100) });
				if (response.ok) return (await response.json()) as Listing;
			} catch {}
			return undefined;
		});
	}
	async function command(...args: string[]) {
		const child = Bun.spawn([process.execPath, cli, ...args], {
			cwd: folder,
			env,
			stderr: 'pipe',
			stdout: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			child.stdout.text(),
			child.stderr.text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		return stdout;
	}
	return {
		folder,
		legacyState,
		invocations,
		marker,
		setTime,
		usePort,
		launch,
		list,
		command,
	};
}

test('serve dispatches once at 8am even when the old scheduler state path is unusable', async () => {
	const home = await fixture();
	const url = await home.usePort();
	await home.setTime('07:59:59');
	const primary = home.launch();
	await home.list(url);
	expect(await home.command()).toContain(
		'morning-flights → flights daily · Next run',
	);
	await writeFile(home.legacyState, 'old scheduler state path is a file');

	// A second launcher resolves the same home even through a directory link and a new port.
	await home.usePort();
	const alias = `${home.folder}-alias`;
	await symlink(home.folder, alias);
	try {
		const second = home.launch({ cwd: alias });
		expect(await second.child.exited).toBe(2);
		expect(await second.stderr).toContain(
			'Epicenter is already running for this home',
		);
		expect(await readFile(home.marker, 'utf8')).toBe('imported\n');
	} finally {
		await rm(alias);
	}
	const port = new URL(url).port;
	await writeFile(
		join(home.folder, 'package.json'),
		JSON.stringify({ epicenter: { port: Number(port) } }),
	);
	await home.setTime('08:00:20');
	const check = join(home.folder, 'data/checks/scheduled.md');
	await waitFor(() => (existsSync(check) ? true : undefined));
	expect(await readFile(check, 'utf8')).toContain('Fixture flight check');
	expect(await readFile(home.invocations, 'utf8')).toBe('{"recheck":false}\n');
	expect(await readFile(home.legacyState, 'utf8')).toBe(
		'old scheduler state path is a file',
	);
	expect((await home.list(url)).schedules?.[0]?.nextRun).toBe(
		'2026-11-27T16:00:00.000Z',
	);

	const manual = await home.command('flights', 'daily', '{"recheck":true}');
	expect(JSON.parse(manual)).toEqual({ state: 'unfinished' });
	expect(await readFile(home.invocations, 'utf8')).toBe(
		'{"recheck":false}\n{"recheck":true}\n',
	);
	primary.child.kill('SIGTERM');
	expect(await primary.child.exited).toBe(0);
	expect(await primary.stderr).toContain('action run ended');
});

test('a crash releases the home lock and a restart during the minute skips the run', async () => {
	const home = await fixture();
	const url = await home.usePort();
	await home.setTime('07:59:59');
	const original = home.launch({ hold: true });
	await home.list(url);
	await home.setTime('08:00:05');
	await waitFor(() => (existsSync(home.invocations) ? true : undefined));
	original.child.kill('SIGKILL');
	expect(await original.child.exited).toBe(137);

	await home.setTime('08:00:45');
	home.launch();
	const listing = await home.list(url);
	expect(listing.schedules?.[0]?.nextRun).toBe('2026-11-27T16:00:00.000Z');
	expect(await readFile(home.invocations, 'utf8')).toBe('{"recheck":false}\n');
	expect(existsSync(home.legacyState)).toBe(false);
});

test('starting at the exact due time skips today', async () => {
	const home = await fixture();
	const url = await home.usePort();
	await home.setTime('08:00:00');
	home.launch();
	const listing = await home.list(url);
	expect(listing.schedules?.[0]?.nextRun).toBe('2026-11-27T16:00:00.000Z');
	expect(existsSync(home.invocations)).toBe(false);
});

test('a late wake skips the expired minute, and next 8am follows the local DST change', async () => {
	const home = await fixture();
	const url = await home.usePort();
	await home.setTime('07:59:59', '2026-10-31', '-07:00');
	home.launch();
	await home.list(url);
	await home.setTime('08:01:00', '2026-10-31', '-07:00');
	await waitFor(async () =>
		(await home.list(url)).schedules?.[0]?.nextRun ===
		'2026-11-01T16:00:00.000Z'
			? true
			: undefined,
	);
	expect(existsSync(home.invocations)).toBe(false);
});

test('a scheduled action error uses the usual runner log and serve stays available', async () => {
	const home = await fixture();
	const url = await home.usePort();
	await home.setTime('07:59:59');
	const service = home.launch({ fails: true });
	await home.list(url);
	await home.setTime('08:00:00');
	await waitFor(() => (existsSync(home.invocations) ? true : undefined));
	expect(await home.command()).toContain(
		'morning-flights → flights daily · Next run',
	);
	service.child.kill('SIGTERM');
	expect(await service.child.exited).toBe(0);
	expect(await service.stderr).toContain('"outcome":"error","error":"Threw"');
});
