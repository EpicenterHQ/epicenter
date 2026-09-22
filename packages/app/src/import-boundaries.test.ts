/**
 * Declaration imports acquire no platform resources, and engine entrypoints
 * stay independent of the application lifetime and platform implementations.
 * These checks run fresh processes and real bundles to expose transitive imports.
 */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

for (const host of [false, true]) {
	test(`a ${host ? 'host' : 'browser'} declaration works without browser globals`, async () => {
		const process = Bun.spawn(
			[
				Bun.which('bun')!,
				'--eval',
				`
                globalThis.isTauri = ${host};
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

for (const host of [false, true]) {
	test(`explicit memory runtime opens without ${host ? 'host' : 'browser'} platform globals`, async () => {
		const child = Bun.spawn(
			[
				Bun.which('bun')!,
				'--eval',
				`
   globalThis.isTauri = ${host};
   for (const name of ['window','document','navigator','indexedDB','Worker']) Reflect.deleteProperty(globalThis,name);
   const {defineApp} = await import('@epicenter/app');
   const {openLocal} = await import('@epicenter/app/open');
   const {createMemoryStoreRuntime} = await import('@epicenter/app/testing');
   const runtime = createMemoryStoreRuntime();
   const app = await openLocal(defineApp({id:'test.no-platform',tables:{},kv:{}}),{runtime});
   await app.close(); await runtime.dispose();
   for (const name of ['indexedDB','IDBRequest','IDBTransaction','IDBKeyRange','IDBDatabase']) { if(globalThis[name] !== undefined) throw new Error('Installed ambient '+name); }
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

test('memory stores ignore foreign IDB globals and leave them untouched', async () => {
	const child = Bun.spawn(
		[
			Bun.which('bun')!,
			'--eval',
			`
  const names=['IDBCursor','IDBCursorWithValue','IDBDatabase','IDBFactory','IDBIndex','IDBKeyRange','IDBObjectStore','IDBRequest','IDBTransaction','indexedDB'];
  const sentinel=new Map(names.map(name=>[name,class ForeignConstructor {}]));
  for(const [name,value] of sentinel) globalThis[name]=value;
  const {createMemoryStoreRuntime}=await import('@epicenter/app/testing');
  const {openLocal}=await import('@epicenter/app/open');
  const {defineApp,defineTable,field}=await import('@epicenter/app');
  const definition=defineApp({id:'test.foreign-idb',kv:{},tables:{notes:defineTable({title:field.string()})}});
  const runtime=createMemoryStoreRuntime();
  const app=await openLocal(definition,{runtime});
  app.tables.notes.create({title:'retained'});
  await app.close();
  const reopened=await openLocal(definition,{runtime});
  if(reopened.tables.notes.rows[0]?.title!=='retained') throw new Error('Lost data');
  await reopened.close();await runtime.dispose();
  if(names.some(name=>globalThis[name]!==sentinel.get(name))) throw new Error('Changed globals');
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
