/**
 * Shared browser SQL transport lifetime.
 *
 * Verifies lazy worker acquisition, failure fan-out, and isolation from late
 * events on retired workers. A subprocess isolates the Worker substitute from
 * other tests. Real OPFS isolation and persistence live in the browser probe.
 */
import { expect, test } from 'bun:test';

test('shared requests fail together and a retired worker cannot fail its replacement', async () => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--eval',
			`
			import { expect } from 'bun:test';
			import { expectErr, expectOk } from 'wellcrafted/testing';
			const workers = [];
			globalThis.Worker = class {
				messages = [];
				terminated = false;
				constructor() { workers.push(this); }
				postMessage(message) { this.messages.push(message); }
				terminate() { this.terminated = true; }
			};
			const { browserSqliteTransport: request } = await import(${JSON.stringify(new URL('./browser-sqlite.js', import.meta.url).href)});
			expect(workers).toHaveLength(0);
			const message = { kind: 'sqlite-acquire', appId: 'so.epicenter.transport-test', replica: {library:'local'} };
			const first = request(message);
			const second = request({ ...message, appId: 'so.epicenter.other-app' });
			expect(workers).toHaveLength(1);
			expect(workers[0].messages.map(({ id }) => id)).toEqual([0, 1]);
			workers[0].onerror({ message: 'worker failed' });
			expect(expectErr(await first).name).toBe('StorageFailed');
			expect(expectErr(await second).name).toBe('StorageFailed');
			expect(workers[0].terminated).toBe(true);
			const replacement = request(message);
			expect(workers).toHaveLength(2);
			let settled = false;
			void replacement.then(() => { settled = true; });
			workers[0].onmessageerror();
			await Promise.resolve();
			expect(settled).toBe(false);
			workers[1].onmessage({ data: { id: 2, response: { kind: 'sqlite-acquire', lifetimeId: 'replacement' } } });
			expect(expectOk(await replacement)).toEqual({ kind: 'sqlite-acquire', lifetimeId: 'replacement' });
			`,
		],
		cwd: import.meta.dir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stdout, stderr }).toEqual({
		exitCode: 0,
		stdout: '',
		stderr: '',
	});
});
