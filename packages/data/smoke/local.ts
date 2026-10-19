/** Run with Bun. Browser binaries are installed separately with Playwright. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import type {} from './client.js';

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		chromium: { type: 'string' },
		firefox: { type: 'string' },
		webkit: { type: 'string' },
		output: { type: 'string' },
	},
});
const bundle = await Bun.build({
	entrypoints: [join(import.meta.dir, 'client.ts')],
	target: 'browser',
	minify: false,
});
if (!bundle.success)
	throw new AggregateError(bundle.logs, 'Browser build failed');
const script = await bundle.outputs[0]!.text();
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request) {
		return new URL(request.url).pathname === '/client.js'
			? new Response(script, { headers: { 'content-type': 'text/javascript' } })
			: new Response(
					'<!doctype html><title>Local engine evidence</title><script type="module" src="/client.js"></script>',
					{ headers: { 'content-type': 'text/html' } },
				);
	},
});
const results = [];

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	for (const [name, browserType] of Object.entries({
		chromium,
		webkit,
		firefox,
	})) {
		const directory = await mkdtemp(join(tmpdir(), `epicenter-data-${name}-`));
		const executablePath = values[name as 'chromium' | 'webkit' | 'firefox'];
		const launch = () =>
			browserType.launchPersistentContext(directory, {
				headless: true,
				executablePath,
			});
		let context = await launch();
		try {
			const id = `smoke-${name}`;
			const first = await context.newPage();
			await first.goto(server.url.href);
			await first.waitForFunction(() => globalThis.dataSmoke !== undefined);
			await first.evaluate((id) => dataSmoke.open(id), id);
			await first.evaluate(() => dataSmoke.seed());
			const abandoned = await first.evaluate(() =>
				dataSmoke.abandonCandidate(),
			);
			check(
				abandoned.persisted === null && abandoned.edits === 1,
				'Unpublished computation changed durable refs',
			);
			await context.close();
			context = await launch();
			const a = await context.newPage();
			const b = await context.newPage();
			for (const page of [a, b]) {
				await page.goto(server.url.href);
				await page.waitForFunction(() => globalThis.dataSmoke !== undefined);
				await page.evaluate((id) => dataSmoke.open(id), id);
			}
			const reopened = await a.evaluate(() => dataSmoke.state());
			check(
				reopened.row?.fields.a === 0 &&
					reopened.state.head === null &&
					reopened.edits.length === 1,
				'Offline save missing after full browser reopen',
			);
			check(
				(await a.evaluate(() => dataSmoke.commit())) === null,
				'Committed before observing the remote',
			);
			await a.evaluate(() => dataSmoke.observeEmpty());
			const writes = 100;
			await Promise.all([
				a.evaluate((count) => dataSmoke.write('a', count), writes),
				b.evaluate((count) => dataSmoke.write('b', count), writes),
				a.evaluate(() => dataSmoke.commitLoop(30)),
			]);
			await a.evaluate(() => dataSmoke.set('a', 101));
			const pending = await a.evaluate(() => dataSmoke.commit());
			check(pending !== null, 'No pending candidate was prepared');
			await b.evaluate(() => dataSmoke.set('b', 101));
			check(
				JSON.stringify(await a.evaluate(() => dataSmoke.commit())) ===
					JSON.stringify(pending),
				'New save replaced an uncertain pending commit',
			);
			check(
				await a.evaluate((pending) => dataSmoke.accept(pending), pending),
				'Exact acknowledgement failed',
			);
			const afterAck = await a.evaluate(() => dataSmoke.state());
			check(
				afterAck.row?.fields.a === 101 && afterAck.row?.fields.b === 101,
				'Independent final edit missing',
			);
			check(afterAck.edits.length > 0, 'Acknowledgement cleared newer work');
			await Promise.all([
				a.evaluate(() => dataSmoke.paragraph('First', 'From tab A')),
				b.evaluate(() => dataSmoke.paragraph('Last', 'From tab B')),
			]);
			const finalPending = await a.evaluate(() => dataSmoke.commit());
			check(finalPending !== null, 'Newer edits were not prepared');
			await a.evaluate((pending) => dataSmoke.accept(pending), finalPending);
			const aState = await a.evaluate(() => dataSmoke.state());
			const bState = await b.evaluate(() => dataSmoke.state());
			const native = await a.evaluate(() => dataSmoke.nativeObjects());
			// The same bytes emitted by the production engine are read by native Git.
			const nativeDir = join(directory, 'native');
			const init = Bun.spawnSync([
				'git',
				'init',
				'--bare',
				'--quiet',
				nativeDir,
			]);
			check(init.exitCode === 0, 'Native Git init failed');
			for (const object of native.objects) {
				const written = Bun.spawnSync(
					[
						'git',
						'--git-dir',
						nativeDir,
						'hash-object',
						'-w',
						'-t',
						object.type,
						'--stdin',
					],
					{ stdin: new Uint8Array(object.bytes) },
				);
				check(
					written.exitCode === 0 &&
						written.stdout.toString().trim() === object.oid,
					'Native Git object identity differs',
				);
			}
			// Snapshot retention explicitly stops commit-parent traversal here.
			await Bun.write(join(nativeDir, 'shallow'), `${native.head}\n`);
			const update = Bun.spawnSync([
				'git',
				'--git-dir',
				nativeDir,
				'update-ref',
				'refs/heads/main',
				native.head!,
			]);
			check(update.exitCode === 0, 'Native Git ref rejected');
			const fsck = Bun.spawnSync([
				'git',
				'--git-dir',
				nativeDir,
				'fsck',
				'--strict',
				'--no-reflogs',
			]);
			check(
				fsck.exitCode === 0,
				`Native Git fsck failed: ${fsck.stderr.toString()}`,
			);
			const show = Bun.spawnSync([
				'git',
				'--git-dir',
				nativeDir,
				'show',
				'main:notes/one.md',
			]);
			check(
				show.stdout.toString().includes('a: 101\nb: 101'),
				'Native Git current data differs',
			);
			check(
				show.stdout.toString().includes('From tab A\n\nFrom tab B\n'),
				'Native Git lost an independent paragraph',
			);
			const latencies = [...aState.latencies, ...bState.latencies].sort(
				(a, b) => a - b,
			);
			await context.close();
			context = await launch();
			const reopenedPage = await context.newPage();
			await reopenedPage.goto(server.url.href);
			await reopenedPage.waitForFunction(
				() => globalThis.dataSmoke !== undefined,
			);
			await reopenedPage.evaluate((id) => dataSmoke.open(id), id);
			const final = await reopenedPage.evaluate(() => dataSmoke.state());
			check(
				final.row?.fields.a === 101 &&
					final.row?.fields.b === 101 &&
					final.row?.body === 'From tab A\n\nFrom tab B\n' &&
					final.edits.length === 0 &&
					final.state.base === final.state.head,
				'Committed current data missing after browser reopen',
			);
			const archive = await context.newPage();
			await archive.goto(server.url.href);
			await archive.waitForFunction(() => globalThis.dataSmoke !== undefined);
			await archive.evaluate((id) => dataSmoke.open(`${id}-archive`), id);
			const metadataProbe = await archive.evaluate(() =>
				dataSmoke.archive(500),
			);
			results.push({
				browser: name,
				version: context.browser()?.version(),
				acknowledgedSaves: writes * 2 + 5,
				failedRevisionChecks: aState.failedChecks + bState.failedChecks,
				saveP95Ms: latencies[Math.floor(latencies.length * 0.95)],
				maxSaveMs: latencies.at(-1),
				metadataProbe,
				final: final.row.fields,
				nativeGit: 'hash-object + fsck --strict + show',
				checks: [
					'offline-first reopen',
					'abandoned candidate',
					'two tabs + commit publication',
					'independent paragraphs',
					'exact pending identity',
					'newer edits survive acknowledgement',
					'committed reopen',
				],
			});
		} finally {
			await context.close();
			await rm(directory, { recursive: true, force: true });
		}
	}
	const report = {
		recordedAt: new Date().toISOString(),
		scope:
			'Production local engine. Local acknowledgement simulation, no network sync, forced process crash, or phone evidence.',
		results,
	};
	if (values.output !== undefined)
		await Bun.write(values.output, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
} finally {
	server.stop(true);
}
