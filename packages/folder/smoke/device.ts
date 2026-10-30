/**
 * `openDevice` from `@epicenter/folder/browser` in real engines: OPFS through
 * the device's one Worker, in Playwright Chromium and WebKit. Run with Bun:
 *
 *   bun packages/folder/smoke/device.ts            # both engines
 *   bun packages/folder/smoke/device.ts webkit     # one
 *
 * Per engine, in a persistent profile (WebKit's ephemeral contexts refuse
 * OPFS, opfs-probe/RESULTS.md):
 *
 * 1. A note lands in house style at its contract path, and 5 MB of audio
 *    reads back byte for byte, its version the sha256 of its bytes.
 * 2. A second tab reads the same files and the outbox capture.
 * 3. Two tabs racing an update over one version: one lands, one `Conflict`.
 *    Two tabs racing a create of one path: one lands, one `Occupied`. The
 *    Web Lock per path is what serializes them across the tabs' Workers.
 * 4. Nothing is left staged, and the files survive a reload and a restart.
 *
 * Then an ephemeral context: Chromium opens OPFS there; WebKit's refusal is
 * `Unavailable` with a `StorageRefused` cause, not a throw.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page, webkit } from 'playwright';
import type {} from './device-client.js';

const engines = { chromium, webkit };
const chosen = Bun.argv.slice(2) as (keyof typeof engines)[];
const names = chosen.length > 0 ? chosen : (['chromium', 'webkit'] as const);

async function bundle(entry: string) {
	const built = await Bun.build({
		entrypoints: [entry],
		target: 'browser',
		minify: false,
	});
	if (!built.success)
		throw new AggregateError(built.logs, `${entry} failed to build`);
	return built.outputs[0]!.text();
}

const client = await bundle(join(import.meta.dir, 'device-client.ts'));
// The client asks for its Worker at `new URL('./opfs-worker.ts', import.meta.url)`.
const worker = await bundle(
	join(import.meta.dir, '../src/device/opfs-worker.ts'),
);
const javascript = { headers: { 'content-type': 'text/javascript' } };
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request) {
		switch (new URL(request.url).pathname) {
			case '/device-client.js':
				return new Response(client, javascript);
			case '/opfs-worker.ts':
				return new Response(worker, javascript);
			default:
				return new Response(
					'<!doctype html><title>Device smoke</title><script type="module" src="/device-client.js"></script>',
					{ headers: { 'content-type': 'text/html' } },
				);
		}
	},
});
// localhost is a secure context, which OPFS and crypto.subtle need.
const origin = `http://localhost:${server.port}/`;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function page(context: BrowserContext) {
	const opened = await context.newPage();
	await opened.goto(origin);
	await opened.waitForFunction(() => globalThis.deviceSmoke !== undefined);
	return opened;
}

const NOTE = '---\ntitle: Standup\ndurationMs: 1500\n---\nNotes.\n';
const results: Record<string, unknown> = {};
let failed = false;

try {
	for (const name of names) {
		const engine = engines[name];
		const profile = await mkdtemp(join(tmpdir(), `epicenter-device-${name}-`));
		const launch = () =>
			engine.launchPersistentContext(profile, { headless: true });
		const steps: string[] = [];
		let context: BrowserContext | undefined;
		let version = '';
		try {
			context = await launch();
			const a = await page(context);
			const seeded = await a.evaluate(() => deviceSmoke.seed('r1'));
			check(!('error' in seeded), `seed failed: ${JSON.stringify(seeded)}`);
			check(
				seeded.noteText === NOTE,
				`note text: ${JSON.stringify(seeded.noteText)}`,
			);
			check(
				seeded.readHash === seeded.expectedAudioHash &&
					seeded.readVersion === seeded.expectedAudioHash &&
					seeded.audioVersion === seeded.expectedAudioHash,
				'audio did not read back byte for byte under its sha256',
			);
			check(seeded.callerBytesIntact, "a write detached the caller's bytes");
			check(
				seeded.occupied === 'Occupied',
				`second create: ${seeded.occupied}`,
			);
			check(seeded.capture === 'pending', `capture: ${seeded.capture}`);
			steps.push(
				'note in house style; 5 MB audio round trip; Occupied; capture pending',
			);

			const b = await page(context);
			const seen = await b.evaluate(() => deviceSmoke.read('r1'));
			check(
				JSON.stringify(seen.notes) ===
					JSON.stringify([{ id: 'r1', title: 'Standup' }]) &&
					JSON.stringify(seen.captures) ===
						JSON.stringify([{ id: 'r1', state: 'pending' }]) &&
					seen.audioHash === seeded.expectedAudioHash,
				`second tab read: ${JSON.stringify(seen)}`,
			);
			steps.push('second tab reads the same files and capture');

			const over = seeded.noteVersion;
			const updates = await Promise.all([
				a.evaluate((over) => deviceSmoke.update('r1', 'From A', over), over),
				b.evaluate((over) => deviceSmoke.update('r1', 'From B', over), over),
			]);
			check(
				[...updates].sort().join() === 'Conflict,landed',
				`racing updates: ${updates}`,
			);
			const creates = await Promise.all([
				a.evaluate(() => deviceSmoke.create('race', 'A')),
				b.evaluate(() => deviceSmoke.create('race', 'B')),
			]);
			check(
				[...creates].sort().join() === 'Occupied,landed',
				`racing creates: ${creates}`,
			);
			steps.push(`two tabs racing: updates ${updates}, creates ${creates}`);

			check(
				(await a.evaluate(() => deviceSmoke.staged())) === 0,
				'staging not empty',
			);
			await a.reload();
			await a.waitForFunction(() => globalThis.deviceSmoke !== undefined);
			const reloaded = await a.evaluate(() => deviceSmoke.read('r1'));
			check(
				Array.isArray(reloaded.notes) && reloaded.notes.length === 2,
				`after reload: ${JSON.stringify(reloaded.notes)}`,
			);
			await context.close();
			context = await launch();
			const restarted = await (await page(context)).evaluate(() =>
				deviceSmoke.read('r1'),
			);
			check(
				restarted.audioHash === seeded.expectedAudioHash &&
					Array.isArray(restarted.notes) &&
					restarted.notes.some(
						({ id, title }) =>
							id === 'r1' && ['From A', 'From B'].includes(title),
					),
				`after restart: ${JSON.stringify(restarted)}`,
			);
			steps.push('nothing staged; files survive reload and restart');
			await context.close();
			context = undefined;

			const browser = await engine.launch({ headless: true });
			try {
				const ephemeral: Page = await page(await browser.newContext());
				version = browser.version();
				const refusal = await ephemeral.evaluate(() => deviceSmoke.refusal());
				if (name === 'webkit')
					check(
						refusal.name === 'Unavailable' &&
							refusal.cause === 'StorageRefused',
						`WebKit ephemeral: ${JSON.stringify(refusal)}`,
					);
				else
					check(
						refusal.name === null,
						`Chromium ephemeral: ${JSON.stringify(refusal)}`,
					);
				steps.push(`ephemeral context: ${JSON.stringify(refusal)}`);
			} finally {
				await browser.close();
			}
			results[name] = { ok: true, version, steps };
		} catch (cause) {
			failed = true;
			results[name] = { ok: false, steps, error: String(cause) };
		} finally {
			await context?.close().catch(() => {});
			await rm(profile, { recursive: true, force: true });
		}
	}
} finally {
	server.stop(true);
}
console.log(JSON.stringify(results, null, 2));
if (failed) process.exitCode = 1;
