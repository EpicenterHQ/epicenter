/**
 * Declaration imports acquire no platform resources, and engine entrypoints
 * stay independent of the application lifetime and platform implementations.
 * These checks run fresh processes and real bundles to expose transitive imports.
 */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

for (const condition of [undefined, 'epicenter-host']) {
	test(`a ${condition ?? 'browser'} declaration works without browser globals`, async () => {
		const process = Bun.spawn(
			[
				Bun.which('bun')!,
				...(condition ? [`--conditions=${condition}`] : []),
				'--eval',
				`
				for (const name of ['window', 'document', 'navigator', 'indexedDB', 'Worker']) {
					Reflect.deleteProperty(globalThis, name);
				}
				const { defineApp, defineTable, field } = await import('@epicenter/app');
				const declaration = defineApp({
					id: 'test.import-boundary', kv: {},
					tables: { notes: defineTable({ title: field.string() }) },
				});
				if (declaration.id !== 'test.import-boundary' || typeof declaration.open !== 'function') {
					throw new Error('The declaration lost its identity or opener.');
				}
				`,
			],
			{ cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
		);
		const [code, stderr] = await Promise.all([
			process.exited,
			new Response(process.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
	});
}

for (const entrypoint of [
	'field',
	'definition',
	'store',
	'direct',
	'sync',
	'artifact',
	'artifact/format',
	'artifact/checkout',
	'memory',
]) {
	test(`${entrypoint} bundles without application or platform implementations`, async () => {
		const process = Bun.spawn(
			[
				Bun.which('bun')!,
				'--eval',
				`
			const result = await Bun.build({
				entrypoints: [Bun.resolveSync('@epicenter/app/${entrypoint}', process.cwd())],
				target: '${entrypoint === 'memory' ? 'bun' : 'browser'}', metafile: true,
			});
			if (!result.success) throw new AggregateError(result.logs);
			console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
			`,
			],
			{ cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
		);
		const [code, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
		const loaded = (JSON.parse(stdout) as string[]).map((path) => `/${path}`);
		expect(loaded.length).toBeGreaterThan(0);
		expect(
			loaded.filter(
				(path) =>
					/\/app\/src\/(?:index\.ts|open\.ts|ai\.ts|ai-connections[^/]*\.ts|native-ai\.ts|platform\/|recording\/|browser\.ts|epicenter-host\.ts)/.test(
						path,
					) ||
					/\/(?:device|blobs)\/src\/(?:browser|desktop|webview)/.test(path) ||
					path.includes('/@tauri-apps/') ||
					path.includes('/openai/'),
			),
		).toEqual([]);
	});
}
