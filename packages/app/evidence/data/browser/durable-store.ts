/**
 * Run: bun packages/app/evidence/data/browser/durable-store.ts [--webkit]
 * Real openApp, IndexedDB, document replacement, and immediate window reopening.
 * A test-only delay before commit proves pending edits can disappear while
 * committed rows remain readable. No unload handler or App.close gates departure.
 * Each operation and the entire run are bounded; failures print the last browser
 * events and claim result. Run at most three times when investigating a stall.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page, webkit } from 'playwright';
import { build } from 'vite';

const engine = process.argv.includes('--webkit') ? webkit : chromium;
// The parent owns temporary files and the deadline, even if a browser protocol
// call hangs. Playwright browsers can create their own process groups, so walk
// descendants before killing the runner instead of relying on its group alone.
if (!process.env.DURABLE_STORE_PROBE_DIRECTORY) {
	const temporary = await mkdtemp(join(tmpdir(), 'epicenter-replacement-'));
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[import.meta.filename, ...process.argv.slice(2)],
				{
					env: { ...process.env, DURABLE_STORE_PROBE_DIRECTORY: temporary },
					stdio: 'inherit',
					detached: process.platform !== 'win32',
				},
			);
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				console.error(
					`${engine.name()}: 120 second deadline; stopping probe and browser descendants`,
				);
				if (!child.pid) return;
				try {
					if (process.platform === 'win32') {
						execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
							timeout: 5_000,
						});
						return;
					}
					const processes = execFileSync('ps', ['-axo', 'pid=,ppid='], {
						encoding: 'utf8',
						timeout: 5_000,
					})
						.trim()
						.split('\n')
						.map((line) => line.trim().split(/\s+/).map(Number));
					const descendants = [child.pid];
					for (let index = 0; index < descendants.length; index++) {
						for (const [pid, parent] of processes) {
							if (pid && parent === descendants[index]) descendants.push(pid);
						}
					}
					for (const pid of descendants.reverse()) {
						try {
							process.kill(pid, 'SIGKILL');
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
								console.error(error);
						}
					}
				} catch (error) {
					console.error('Could not stop every probe descendant:', error);
				} finally {
					// A failed process listing or taskkill must still terminate the
					// runner and let its exit handler release the parent's cleanup.
					child.kill('SIGKILL');
				}
			}, 120_000);
			child.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once('exit', (code, signal) => {
				clearTimeout(timer);
				console.log(
					`${engine.name()}: probe process exited (${signal ?? code})`,
				);
				if (code === 0 && !timedOut) resolve();
				else
					reject(
						new Error(
							`Probe ${timedOut ? 'timed out' : `exited with ${signal ?? code}`}`,
						),
					);
			});
		});
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	process.exit(0);
}
const temporary = process.env.DURABLE_STORE_PROBE_DIRECTORY;
const outDir = join(temporary, 'web');
const events: string[] = [];
let step = 'build';
function record(event: string) {
	events.push(`${new Date().toISOString()} ${event}`);
	if (events.length > 60) events.shift();
}
const watchdog = setTimeout(() => {
	console.error(`${engine.name()}: timed out at ${step}`, events);
	// Keep ownership intact until the parent stops the complete process tree.
}, 115_000);
let browser:
	| Awaited<ReturnType<typeof engine.launchPersistentContext>>
	| undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
async function bounded<T>(label: string, work: Promise<T>): Promise<T> {
	step = label;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out: ${label}`)),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
try {
	let injected = false;
	await build({
		configFile: false,
		root: new URL('./durable-store/', import.meta.url).pathname,
		logLevel: 'error',
		plugins: [
			{
				name: 'evidence-pending-commit',
				transform(source, id) {
					if (!id.endsWith('/data/store/persistence.ts')) return;
					const target = 'await port.commit(batch);';
					assert.ok(
						source.includes(target),
						'persistence injection point exists',
					);
					injected = true;
					return source.replace(
						target,
						`
					const delay = Number(new URL(location.href).searchParams.get('commitDelay') ?? 0);
					if (delay) await new Promise(resolve => setTimeout(resolve, delay));
					${target}`,
					);
				},
			},
		],
		build: { target: 'esnext', outDir, emptyOutDir: true },
	});
	assert.ok(
		injected,
		'pending-write control must instrument actual persistence',
	);
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const file = Bun.file(join(outDir, path === '/' ? 'index.html' : path));
			return (await file.exists())
				? new Response(file)
				: new Response('missing', { status: 404 });
		},
	});
	const origin = `http://localhost:${server.port}`;
	browser = await bounded(
		'launch',
		engine.launchPersistentContext(join(temporary, 'profile'), {
			timeout: 8_000,
		}),
	);
	browser.on('close', () => record('browser context closed'));
	async function newPage() {
		const page = await browser!.newPage();
		page.setDefaultTimeout(10_000);
		page.on('console', (message) =>
			record(`console ${message.type()}: ${message.text()}`),
		);
		page.on('pageerror', (error) => record(`pageerror ${error.message}`));
		page.on('crash', () => record('page crashed'));
		page.on('close', () => record('page closed'));
		page.on('framenavigated', (frame) => record(`navigation ${frame.url()}`));
		return page;
	}
	async function open(page: Page, href = origin, name = 'vault') {
		await bounded('navigate', page.goto(href));
		await claim(page, name);
	}
	async function claim(page: Page, name = 'vault') {
		await page.waitForFunction(
			'document.querySelector("#out")?.textContent?.includes("ready")',
		);
		const result = await bounded(
			'openApp claim',
			page.evaluate((name) => {
				return (
					globalThis as unknown as { open(name: string): Promise<unknown> }
				).open(name);
			}, name),
		);
		record(`claim ${JSON.stringify(result)}`);
		assert.deepEqual(result, { ok: true });
	}
	async function read(page: Page) {
		return (await bounded('read', page.evaluate('globalThis.read()'))) as {
			notes: { title: string; text: string }[];
			durability: { healthy: boolean };
		};
	}
	let page = await newPage();
	await open(page);
	assert.deepEqual(
		await bounded(
			'seed',
			page.evaluate('globalThis.write("committed", "saved text")'),
		).then((result) => (result as { durable: boolean }).durable),
		true,
	);
	for (let iteration = 0; iteration < 50; iteration++) {
		await bounded(
			'ordinary edit',
			page.evaluate(
				`globalThis.write("edit-${iteration}", "ordinary text", false)`,
			),
		);
		await open(page);
		const reading = await read(page);
		assert.ok(reading.durability.healthy);
		assert.ok(
			reading.notes.some(
				(note) =>
					note.title === 'committed' && note.text.includes('saved text'),
			),
		);
	}
	console.log(
		`${engine.name()}: 50 reloads after ordinary writes retained committed data`,
	);
	let sameTaskSurvivors = 0;
	for (let iteration = 0; iteration < 20; iteration++) {
		await bounded(
			'same-task write and reload',
			Promise.all([
				page.waitForNavigation(),
				page.evaluate((iteration) => {
					const probe = globalThis as unknown as {
						write(
							title: string,
							text: string,
							flush: boolean,
						): Promise<unknown>;
					};
					void probe.write(`same-task-${iteration}`, 'ordinary text', false);
					location.reload();
				}, iteration),
			]),
		);
		// Claim this replacement document directly; navigating again would
		// hide whether immediate admission after the interrupted write worked.
		await claim(page);
		const reading = await read(page);
		assert.ok(reading.durability.healthy);
		assert.ok(
			reading.notes.some(
				(note) =>
					note.title === 'committed' && note.text.includes('saved text'),
			),
		);
		if (reading.notes.some((note) => note.title === `same-task-${iteration}`))
			sameTaskSurvivors++;
	}
	console.log(
		`${engine.name()}: 20 same-task write/reload cycles retained committed data; ${sameTaskSurvivors}/20 pending edits survived (informational)`,
	);
	for (let iteration = 0; iteration < 20; iteration++) {
		await bounded(
			'edit before window close',
			page.evaluate(
				`globalThis.write("window-${iteration}", "ordinary text", false)`,
			),
		);
		await page.close();
		page = await newPage();
		await open(page);
		assert.ok(
			(await read(page)).notes.some((note) => note.title === 'committed'),
		);
	}
	console.log(
		`${engine.name()}: 20 immediate window reopen cycles retained committed data`,
	);
	for (let iteration = 0; iteration < 3; iteration++) {
		await open(page, `${origin}?commitDelay=2000`);
		const pending = (await bounded(
			'delayed edit',
			page.evaluate(
				`globalThis.write("pending-${iteration}", "lost text", false)`,
			),
		)) as { durable: boolean };
		assert.equal(pending.durable, false);
		await open(page);
		const reading = await read(page);
		assert.ok(reading.notes.some((note) => note.title === 'committed'));
		assert.ok(
			!reading.notes.some((note) => note.title === `pending-${iteration}`),
		);
	}
	console.log(
		`${engine.name()}: 3 delayed pending-write losses reopened with committed data intact`,
	);
	await open(page, `${origin}?commitDelay=200`);
	assert.equal(
		(
			(await bounded(
				'delayed commit completion',
				page.evaluate('globalThis.write("delayed-committed", "retained")'),
			)) as { durable: boolean }
		).durable,
		true,
	);
	await open(page);
	assert.ok(
		(await read(page)).notes.some((note) => note.title === 'delayed-committed'),
	);
	await open(page, origin, 'somewhere-else');
	assert.deepEqual((await read(page)).notes, []);
	await open(page);
	const original = await read(page);
	assert.ok(
		original.notes.some(
			(note) => note.title === 'committed' && note.text.includes('saved text'),
		),
	);
	assert.ok(original.notes.some((note) => note.title === 'delayed-committed'));
	console.log(
		`${engine.name()}: completed delayed commit survived; independent namespace remained empty; original vault survived`,
	);
} catch (error) {
	console.error(`${engine.name()}: failed at ${step}\n${events.join('\n')}`);
	throw error;
} finally {
	try {
		await bounded('browser close', browser?.close() ?? Promise.resolve());
	} catch (error) {
		console.error(`${engine.name()}: browser cleanup failed`, error, events);
		// Preserve the runner's descendant relationship for the parent's kill.
		await new Promise(() => {});
	} finally {
		await server?.stop(true);
		clearTimeout(watchdog);
	}
}
