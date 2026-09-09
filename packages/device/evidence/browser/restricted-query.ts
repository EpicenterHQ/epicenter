/** Run production restricted SQL in Chromium or WebKit: bun run this-file [--webkit]. */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { build } from 'vite';

const temporary = await mkdtemp(join(tmpdir(), 'epicenter-query-'));
const root = new URL('./restricted-query/', import.meta.url).pathname;
await build({
	root,
	configFile: false,
	logLevel: 'warn',
	worker: { format: 'es' },
	build: { target: 'esnext', outDir: join(temporary, 'web') },
});
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		return new Response(
			Bun.file(join(temporary, 'web', path === '/' ? 'index.html' : path)),
		);
	},
});
const engine = process.argv.includes('--webkit') ? webkit : chromium;
let browser;
try {
	browser = await engine.launchPersistentContext(join(temporary, 'profile'));
	const page = await browser.newPage();
	await page.goto(`http://localhost:${server.port}`);
	await page.waitForFunction('globalThis.evidence !== undefined', undefined, {
		timeout: 60000,
	});
	const evidence = await page.evaluate(
		() =>
			(
				globalThis as unknown as {
					evidence: {
						failure?: string;
						failures: string[];
						observations: Record<string, unknown>;
					};
				}
			).evidence,
	);
	console.log(JSON.stringify({ engine: engine.name(), evidence }, null, 2));
	if (evidence.failure || evidence.failures.length)
		throw new Error(evidence.failure ?? evidence.failures.join(', '));
	const results = evidence.observations as Record<
		string,
		{ data?: { columns: string[]; rows: unknown[][]; truncated: boolean } }
	>;
	if (JSON.stringify(results.zero?.data?.columns) !== '["id"]')
		throw new Error('Empty result lost headers.');
	if (JSON.stringify(results.duplicates?.data?.columns) !== '["value","value"]')
		throw new Error('Duplicate headers lost.');
	if (
		!results.excessiveRows?.data?.truncated ||
		results.excessiveRows.data.rows.length !== 1000
	)
		throw new Error('Row limit failed.');
	if (!results.excessiveBytes?.data?.truncated)
		throw new Error('Result byte limit failed.');
	console.log('Production worker boundary and recovery assertions passed.');
} finally {
	await browser?.close();
	server.stop(true);
	await rm(temporary, { recursive: true, force: true });
}
