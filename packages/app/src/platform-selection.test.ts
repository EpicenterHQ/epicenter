/** Runtime selection stays inert on import and explicit runtimes bypass detection. */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

for (const host of [false, true]) {
	test(`default runtime and clipboard select ${host ? 'host' : 'browser'} without I/O`, async () => {
		const child = Bun.spawn(
			[
				Bun.which('bun')!,
				'--eval',
				`
   globalThis.isTauri = ${host};
   for (const name of ['window','document','navigator']) Reflect.deleteProperty(globalThis,name);
   for (const name of ['indexedDB','Worker','WebSocket','EventSource']) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error('Import accessed '+name); } });
   }
   globalThis.fetch = () => { throw new Error('Import performed fetch'); };
   const {defaultRuntime} = await import('./src/platform/default.ts');
   const {resources} = await import('./src/platform/${host ? 'epicenter-host' : 'browser'}.ts');
   const {clipboard} = await import('./src/clipboard.ts');
   const {clipboard: expectedClipboard} = await import('./src/clipboard/${host ? 'epicenter-host' : 'browser'}.ts');
   if (defaultRuntime() !== resources || clipboard !== expectedClipboard) throw new Error('Wrong platform selected');
  `,
			],
			{ cwd, stdout: 'pipe', stderr: 'pipe' },
		);
		const [code, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
	});
}

test('an explicit memory runtime never reads the platform marker', async () => {
	const child = Bun.spawn(
		[
			Bun.which('bun')!,
			'--eval',
			`
  Object.defineProperty(globalThis, 'isTauri', {get() {throw new Error('Detected platform');}});
  const {openApp} = await import('./src/open.ts');
  const {defineApp} = await import('./src/index.ts');
  const {createMemoryRuntime} = await import('./src/testing.ts');
  const runtime = createMemoryRuntime();
  const app = await openApp(defineApp({id:'test.explicit-runtime',tables:{},kv:{}}),{runtime});
  await app.close(); await runtime.dispose();
 `,
		],
		{ cwd, stdout: 'pipe', stderr: 'pipe' },
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
});

test('default host opening reports failed host storage without browser fallback', async () => {
	const child = Bun.spawn(
		[
			Bun.which('bun')!,
			'--eval',
			`
  globalThis.isTauri = true; // Marker read by the installed Tauri API.
  globalThis.location = {origin:'http://host.test'};
  globalThis.window = {location:globalThis.location};
  let requests=0;
  globalThis.fetch=async()=>{requests++;throw new Error('Host offline');};
  globalThis.EventSource=class {constructor(){requests++;throw new Error('Host events offline');}};
  Object.defineProperty(globalThis,'Worker',{get(){throw new Error('Browser fallback');}});
  const {resources:host}=await import('./src/platform/epicenter-host.ts');
  const {createMemoryRuntime}=await import('./src/testing.ts');
  const runtime=createMemoryRuntime();
  host.claim=runtime.claim;
  host.data=runtime.data;
  const {openApp}=await import('./src/open.ts');
  const {defineApp}=await import('./src/index.ts');
  let failure;
  try { await openApp(defineApp({id:'test.host-failure',tables:{},kv:{}})); } catch(error) { failure=error; }
  if(failure?.name!=='StorageFailed'||requests===0) throw new Error('Did not report host failure: '+JSON.stringify(failure));
  await runtime.dispose();
 `,
		],
		{ cwd, stdout: 'pipe', stderr: 'pipe' },
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
});
