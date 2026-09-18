/**
 * Does an application's SQLite actually work in a browser?
 *
 * Run: `bun run evidence/browser/opfs-sqlite.ts [--webkit]`
 *
 * `src/browser-sqlite.ts` and its worker are a claim about a runtime, and it
 * is a claim the leaf they replaced got wrong for as long as it existed: it
 * called `sqlite3.oo1.OpfsDb` from the page, where that constructor does not
 * exist, so every browser build of every Epicenter application had storage
 * that could only fail. Typecheck said nothing, and no `bun test` can, because
 * OPFS synchronous access handles exist only inside a real browser's worker.
 * This runs the real binding in a real page.
 *
 * METHOD, and the controls are the point:
 *
 *   - **The reload is real.** `page.reload()` discards the page, its worker,
 *     and the pool's handles. Anything that comes back came off disk.
 *   - **CONTROL: a second name must see nothing.** A run where every name
 *     resolved to one file would otherwise pass every durability check.
 *   - **CONTROL: more databases than the pool's default capacity.** The pool
 *     pre-allocates six slots and refuses past them, so a fixture that opened
 *     two would never meet the failure a person meets on their third account.
 *   - **CONTROL: a batch that fails partway must leave nothing.** A batch that
 *     wrote its first statement and stopped would otherwise read as a pass in
 *     any test that only counts the rows it expected.
 *   - **No cross-origin isolation headers**, deliberately. The pool is chosen
 *     precisely so a deployment does not need them; serving them here would
 *     make this page more capable than any real one.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { build } from 'vite';

/**
 * Which engine to prove it in. `--webkit` is not a nicety: the desktop ships a
 * WKWebView and Honeycrisp is deployed to the open web, so a result from
 * Chromium alone says the code works somewhere other than where it runs. The
 * two engines also disagree about what a second tab's refusal is called, which
 * is exactly the kind of thing one engine cannot show.
 */
const ENGINE = process.argv.includes('--webkit') ? webkit : chromium;

const root = new URL('./opfs-sqlite/', import.meta.url).pathname;
const outDir = new URL('./opfs-sqlite-dist/', import.meta.url).pathname;

console.log('\nbuilding the probe page\n');
await build({
	root,
	logLevel: 'warn',
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
	worker: { format: 'es' },
	build: { target: 'esnext', outDir, emptyOutDir: true },
});

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		const file = Bun.file(
			`${outDir}${pathname === '/' ? 'index.html' : pathname.slice(1)}`,
		);
		if (!(await file.exists()))
			return new Response('not found', { status: 404 });
		return new Response(file);
	},
});
const origin = `http://localhost:${server.port}`;

type Answer = {
	ok: boolean;
	value?: unknown;
	error?: string;
	errorName?: string;
};

// A PERSISTENT context, not an ephemeral one. WebKit refuses a sync access
// handle in a throwaway profile, which reads as a code failure and is a
// harness artifact: the origin private file system needs somewhere to be.
const profile = mkdtempSync(join(tmpdir(), 'epicenter-opfs-sqlite-'));
const browser = await ENGINE.launchPersistentContext(profile, {});
console.log(`engine: ${ENGINE.name()}\n`);

let failures = 0;
function check(label: string, held: boolean, detail: unknown = ''): void {
	if (!held) failures += 1;
	console.log(`  ${held ? 'held  ' : 'FAILED'}  ${label.padEnd(56)} ${detail}`);
}

const ready = (page: {
	waitForFunction(expression: string): Promise<unknown>;
}) => page.waitForFunction('typeof globalThis.run === "function"');

try {
	const page = await browser.newPage();
	page.on('pageerror', (error) =>
		console.log(`  page error: ${error.message}`),
	);
	await page.goto(origin);
	await ready(page);

	const call = async (verb: string, ...args: unknown[]): Promise<Answer> =>
		(await page.evaluate(
			([name, rest]) =>
				(globalThis as Record<string, (...a: unknown[]) => Promise<Answer>>)[
					name as string
				](...(rest as unknown[])),
			[verb, args] as const,
		)) as Answer;

	console.log('1. open, write, and read back through the binding');
	const created = await call('run', 'local', 'CREATE TABLE t(n INTEGER)');
	check('the database opened and took DDL', created.ok, created.error ?? '');
	await call('run', 'local', 'INSERT INTO t VALUES (?)', [1]);
	const written = await call('run', 'local', 'INSERT INTO t VALUES (?)', [2]);
	check(
		'a write reports one changed row',
		(written.value as { changes: number } | undefined)?.changes === 1,
		JSON.stringify(written.value),
	);
	const sibling = await call('otherApp', 'SELECT name FROM sqlite_master');
	check(
		'another app owner shares the pool with isolated files',
		sibling.ok && JSON.stringify(sibling.value) === '[]',
		sibling.error ?? JSON.stringify(sibling.value),
	);
	const siblingCreated = await call(
		'otherApp',
		'CREATE TABLE sibling(n INTEGER)',
	);
	check(
		'another app can write through its own owner',
		siblingCreated.ok,
		siblingCreated.error ?? '',
	);

	const duplicate = await call('duplicateOwner');
	check(
		'duplicate app/account lifetime is refused',
		duplicate.ok,
		duplicate.error ?? '',
	);
	const closed = await call('closeAndReopen');
	check(
		'physical close retires handles and allows reacquisition',
		closed.ok,
		closed.error ?? '',
	);
	const afterClose = await call('all', 'local', 'SELECT n FROM t ORDER BY n');
	check(
		'explicit close preserves the database file',
		JSON.stringify(afterClose.value) === JSON.stringify([{ n: 1 }, { n: 2 }]),
		JSON.stringify(afterClose.value),
	);
	const siblingAfterClose = await call(
		'otherApp',
		'SELECT count(*) AS c FROM sibling',
	);
	check(
		'closing one lifetime preserves the second owner',
		JSON.stringify(siblingAfterClose.value) === JSON.stringify([{ c: 0 }]),
		siblingAfterClose.error ?? '',
	);

	console.log(
		'\n2. reload the page, which discards the worker and its handles',
	);
	await page.reload();
	await ready(page);
	const survived = await call('all', 'local', 'SELECT n FROM t ORDER BY n');
	check(
		'both rows survived',
		JSON.stringify(survived.value) === JSON.stringify([{ n: 1 }, { n: 2 }]),
		JSON.stringify(survived.value),
	);
	const siblingSurvived = await call(
		'otherApp',
		"SELECT name FROM sqlite_master WHERE name = 'sibling'",
	);
	check(
		'the other app file survives reload',
		JSON.stringify(siblingSurvived.value) ===
			JSON.stringify([{ name: 'sibling' }]),
		siblingSurvived.error ?? JSON.stringify(siblingSurvived.value),
	);

	console.log('\n3. CONTROL: another name is another database');
	const other = await call('all', 'other', 'SELECT name FROM sqlite_master');
	check(
		'a second name holds no tables',
		Array.isArray(other.value) && (other.value as unknown[]).length === 0,
		JSON.stringify(other.value),
	);

	console.log('\n4. more databases than the pool allocates by default');
	const opens: string[] = [];
	for (let index = 0; index < 8; index += 1) {
		const name = `pressure-${index}`;
		const made = await call('run', name, 'CREATE TABLE t(n INTEGER)');
		if (!made.ok) opens.push(`${name}: ${made.error}`);
	}
	check(
		'eight databases past a six-slot pool all opened',
		opens.length === 0,
		opens.join('; '),
	);
	const journals: string[] = [];
	for (let index = 0; index < 8; index += 1) {
		const result = await call(
			'run',
			`pressure-${index}`,
			'BEGIN IMMEDIATE; INSERT INTO t VALUES (1)',
		);
		if (!result.ok) journals.push(`${index}: ${result.error}`);
	}
	check(
		'each open database has room for its own live journal',
		journals.length === 0,
		journals.join('; '),
	);
	for (let index = 0; index < 8; index += 1) {
		await call('run', `pressure-${index}`, 'ROLLBACK');
	}

	console.log('\n5. a batch that fails partway leaves nothing behind');
	await call('run', 'rollback', 'CREATE TABLE t(n INTEGER PRIMARY KEY)');
	const partial = await call('batch', 'rollback', [
		{ sql: 'INSERT INTO t VALUES (?)', parameters: [1] },
		{ sql: 'INSERT INTO t VALUES (?)', parameters: [1] },
	]);
	check('the batch reported a failure', !partial.ok, partial.error ?? '');
	const after = await call('all', 'rollback', 'SELECT count(*) AS c FROM t');
	check(
		'and wrote no row at all',
		JSON.stringify(after.value) === JSON.stringify([{ c: 0 }]),
		JSON.stringify(after.value),
	);

	console.log('\n6. delete, then open the same name again');
	const removed = await call('remove', 'local');
	check('the delete succeeded', removed.ok, removed.error ?? '');
	const siblingAfterDelete = await call(
		'otherApp',
		'SELECT count(*) AS c FROM sibling',
	);
	check(
		'deleting one app file preserves the other app connection',
		JSON.stringify(siblingAfterDelete.value) === JSON.stringify([{ c: 0 }]),
		siblingAfterDelete.error ?? JSON.stringify(siblingAfterDelete.value),
	);
	const reopened = await call('all', 'local', 'SELECT name FROM sqlite_master');
	check(
		'the name reopens empty rather than failing forever',
		Array.isArray(reopened.value) && (reopened.value as unknown[]).length === 0,
		JSON.stringify(reopened.value),
	);

	console.log('\n7. a second tab of the same origin');
	const second = await browser.newPage();
	await second.goto(origin);
	await ready(second);
	const contested = (await second.evaluate(() =>
		(globalThis as Record<string, (...a: unknown[]) => Promise<Answer>>).all(
			'local',
			'SELECT 1',
		),
	)) as Answer;
	check(
		'the competing library is refused before opening its pool',
		!contested.ok && contested.errorName === 'AlreadyOpen',
		contested.error ?? '',
	);
	const competingWorkers = await second.evaluate(() =>
		(globalThis as unknown as { workerCount(): number }).workerCount(),
	);
	check(
		'refused tab never started a SQLite worker',
		competingWorkers === 0,
		competingWorkers,
	);
	const firstStillWorks = await call(
		'run',
		'local',
		'CREATE TABLE t2(n INTEGER)',
	);
	check(
		'CONTROL: and the first tab is untouched by the refusal',
		firstStillWorks.ok,
		firstStillWorks.error ?? '',
	);
	await second.close();

	console.log('\n8. independent windows and close without page teardown');
	const independent = await browser.newPage();
	await independent.goto(`${origin}/?appId=so.epicenter.independent`);
	await ready(independent);
	const independentOpened = await independent.evaluate(() =>
		(globalThis as Record<string, (...a: unknown[]) => Promise<Answer>>).run(
			'local',
			'CREATE TABLE independent(n INTEGER)',
		),
	);
	check(
		'a different app opens while the first window stays live',
		independentOpened.ok,
		independentOpened.error ?? '',
	);
	await independent.close();

	const released = await call('closeStorage');
	check(
		'the first window explicitly closes its storage',
		released.ok,
		released.error ?? '',
	);
	const successor = await browser.newPage();
	await successor.goto(origin);
	await ready(successor);
	const handoff = await successor.evaluate(() =>
		(globalThis as Record<string, (...a: unknown[]) => Promise<Answer>>).all(
			'local',
			"SELECT name FROM sqlite_master WHERE name = 't2'",
		),
	);
	check(
		'another window acquires the closed owner without page teardown',
		handoff.ok &&
			JSON.stringify(handoff.value) === JSON.stringify([{ name: 't2' }]),
		handoff.error ?? JSON.stringify(handoff.value),
	);
	await successor.close();
} finally {
	await browser.close();
	server.stop(true);
	rmSync(profile, { recursive: true, force: true });
}

console.log(
	failures === 0
		? '\nevidence: every claim held\n'
		: `\nevidence: ${failures} claim(s) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
