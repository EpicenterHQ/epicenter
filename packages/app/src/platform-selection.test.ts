/** Runtime selection stays inert on import and explicit runtimes bypass detection. */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

test('an explicit memory runtime never reads the platform marker', async () => {
	const child = Bun.spawn(
		[
			Bun.which('bun')!,
			'--eval',
			`
  Object.defineProperty(globalThis, 'isTauri', {get() {throw new Error('Detected platform');}});
  const {openLocal} = await import('./src/open.ts');
  const {defineApp} = await import('./src/index.ts');
  const {createMemoryStoreRuntime} = await import('./src/testing.ts');
  const runtime = createMemoryStoreRuntime();
  const app = await openLocal(defineApp({id:'test.explicit-runtime',tables:{},kv:{}}),{runtime});
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
