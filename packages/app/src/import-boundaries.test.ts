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
				if (declaration.id !== 'test.import-boundary' || 'open' in declaration) {
					throw new Error('The declaration lost its identity or contains an opener.');
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
	'',
	'field',
	'definition',
	'store',
	'data',
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
				entrypoints: [Bun.resolveSync('@epicenter/app${entrypoint ? `/${entrypoint}` : ''}', process.cwd())],
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
					/\/app\/src\/(?:open\.ts|compose\.ts|ai\.ts|ai-connections[^/]*\.ts|native-ai\.ts|platform\/|recording\/|browser\.ts|epicenter-host\.ts)/.test(
						path,
					) ||
					/\/(?:device|blobs)\/src\/(?:browser|desktop|webview)/.test(path) ||
					path.includes('/@tauri-apps/') ||
					path.includes('/openai/'),
			),
		).toEqual([]);
	});
}

for (const condition of [undefined, 'epicenter-host']) {
	test(`explicit memory runtime opens without ${condition ?? 'browser'} platform globals`, async () => {
		const child = Bun.spawn(
			[
				Bun.which('bun')!,
				...(condition ? [`--conditions=${condition}`] : []),
				'--eval',
				`
   for (const name of ['window','document','navigator','indexedDB','Worker']) Reflect.deleteProperty(globalThis,name);
   const {defineApp} = await import('@epicenter/app');
   const {openApp} = await import('@epicenter/app/open');
   const {createMemoryRuntime} = await import('@epicenter/app/testing');
   const runtime = createMemoryRuntime();
   const app = openApp(defineApp({id:'test.no-platform',tables:{},kv:{}}),{runtime});
   const ready = await app.ready;
   if(ready.error) throw ready.error;
   await app.close(); await runtime.dispose();
   if(globalThis.indexedDB !== undefined) throw new Error('Installed an ambient storage factory');
  `,
			],
			{ cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
		);
		const [code, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
	});
}

test('memory runtime rejects foreign IDB constructors before installing any globals', async () => {
	const child = Bun.spawn(
		[
			Bun.which('bun')!,
			'--eval',
			`
  const {createMemoryRuntime} = await import('@epicenter/app/testing');
  const names=['IDBCursor','IDBCursorWithValue','IDBDatabase','IDBIndex','IDBKeyRange','IDBObjectStore','IDBRequest'];
  for(const name of names) Reflect.deleteProperty(globalThis,name);
  globalThis.IDBTransaction=class ForeignTransaction {};
  try {createMemoryRuntime();throw new Error('Accepted foreign constructors');}
  catch(error) {if(!error.message.includes('isolated test process')) throw error;}
  if(names.some(name=>globalThis[name]!==undefined)) throw new Error('Partially installed constructors');
 `,
		],
		{ cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' },
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
});
