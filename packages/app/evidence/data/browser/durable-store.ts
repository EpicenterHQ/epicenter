/**
 * Does a browser store actually survive a reload?
 *
 * Run: `bun run evidence/browser/durable-store.ts`
 *
 * `src/store/browser.ts` is a claim about a runtime: that a page can hold the
 * synchronous store over a live `Y.Doc` while IndexedDB holds the update chain
 * that has to survive, and that reopening replays the one from the other.
 * Typecheck cannot judge any of that. This runs it in a real Chromium, in a
 * real page, across a real reload.
 *
 * METHOD, and the controls are the point:
 *
 *   - **The reload is real.** `page.reload()`, so the page's memory, its
 *     `Y.Doc` and everything derived from it are gone. Anything that comes back
 *     came out of IndexedDB.
 *   - **CONTROL: a different name must see nothing.** If a second store opened
 *     under another name found the first one's notes, this would be measuring a
 *     page that never reloaded, or a read of the wrong record.
 *   - **CONTROL: node text, not just values.** A row's node is a nested subtree
 *     inside the one document, so a run that restored a row's values and lost
 *     its node would otherwise read as a pass.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';

/**
 * Which engine to prove it in. `--webkit` is not a nicety: the desktop ships a
 * WKWebView, so a result from Chromium alone says the code works somewhere
 * other than where it runs.
 */
const ENGINE = process.argv.includes('--webkit') ? webkit : chromium;

import { build } from 'vite';

const root = new URL('./durable-store/', import.meta.url).pathname;
const outDir = new URL('./durable-store-dist/', import.meta.url).pathname;

console.log('\nbuilding the probe page\n');
await build({
	root,
	logLevel: 'warn',
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
		// No cross-origin isolation headers. Nothing needs them now that the
		// durable copy is IndexedDB rather than an OPFS file, and serving them
		// would make this page more capable than a real deployment's.
		return new Response(file);
	},
});
const origin = `http://localhost:${server.port}`;

type Reading = {
	notes: { title: string; text: string }[];
	durability: { healthy: boolean };
	pressure?: { items: number; liveRows: number; itemsPerLiveRow: number };
};

// A PERSISTENT context, not an ephemeral one. WebKit refuses a sync access
// handle in a throwaway profile with `UnknownError`, which reads as a code
// failure and is a harness artifact: the origin private file system needs
// somewhere to actually be.
const profile = mkdtempSync(join(tmpdir(), 'epicenter-durable-'));
const browser = await ENGINE.launchPersistentContext(profile, {});
console.log(`engine: ${ENGINE.name()}\n`);
let failures = 0;
function check(label: string, held: boolean, detail: unknown = ''): void {
	if (!held) failures += 1;
	console.log(`  ${held ? 'held  ' : 'FAILED'}  ${label.padEnd(52)} ${detail}`);
}

try {
	const page = await browser.newPage();
	page.on('pageerror', (error) =>
		console.log(`  page error: ${error.message}`),
	);
	await page.goto(origin);
	await page.waitForFunction('typeof globalThis.open === "function"');

	console.log('1. write two notes with text, then reload the page');
	const opened = await page.evaluate('globalThis.open("vault")');
	check(
		'the store opened',
		(opened as { ok?: boolean }).ok === true,
		JSON.stringify(opened),
	);

	await page.evaluate('globalThis.write("Groceries", "milk and eggs")');
	await page.evaluate('globalThis.write("Ideas", "a note about notes")');
	const before = (await page.evaluate('globalThis.read()')) as Reading;
	check('two notes before the reload', before.notes.length === 2);

	await page.reload();
	await page.waitForFunction('typeof globalThis.open === "function"');
	await page.evaluate('globalThis.open("vault")');
	const after = (await page.evaluate('globalThis.read()')) as Reading;

	check(
		'both notes survived the reload',
		after.notes.length === 2,
		after.notes.map((note) => note.title).join(', '),
	);
	check(
		'their text survived too',
		after.notes.every(
			(note) =>
				note.text.includes('milk and eggs') ||
				note.text.includes('a note about notes'),
		),
	);
	check('the durable log reports healthy', after.durability.healthy === true);
	check(
		'pressure is readable',
		(after.pressure?.liveRows ?? -1) === 2,
		`${after.pressure?.items} items / ${after.pressure?.liveRows} rows`,
	);

	console.log('\n2. CONTROL: a different dataId is a different file');
	await page.reload();
	await page.waitForFunction('typeof globalThis.open === "function"');
	await page.evaluate('globalThis.open("somewhere-else")');
	const elsewhere = (await page.evaluate('globalThis.read()')) as Reading;
	check(
		'a store under another dataId sees nothing',
		elsewhere.notes.length === 0,
		`${elsewhere.notes.length} notes`,
	);

	console.log('\n3. and the original is still there afterwards');
	await page.reload();
	await page.waitForFunction('typeof globalThis.open === "function"');
	await page.evaluate('globalThis.open("vault")');
	const again = (await page.evaluate('globalThis.read()')) as Reading;
	check('the vault still holds both notes', again.notes.length === 2);
} finally {
	await browser.close();
	rmSync(profile, { recursive: true, force: true });
	await server.stop(true);
}

console.log(
	failures === 0
		? '\nA browser page holds the synchronous store, and its durable state survives a reload.\n'
		: `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
