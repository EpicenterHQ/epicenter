/** Product startup unwinds each successful acquisition when a later opener fails. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const [path, exported] of [
	[
		'apps/whispering/src/lib/whispering/resources.ts',
		'openWhisperingResources',
	],
	['apps/local-mail/ui/src/lib/resources.ts', 'openMailResources'],
	['apps/honeycrisp/src/lib/resources.ts', 'openHoneycrispResources'],
	['apps/vocab/src/lib/resources.ts', 'openVocabResources'],
] as const)
	test(`${exported} rolls back every partial startup and retains terminal close`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'product-startup-'));
		const key = `startup_${crypto.randomUUID()}`;
		const globals = globalThis as unknown as Record<string, unknown>;
		const acquired: Array<{ signal: AbortSignal; close(): Promise<void> }> = [];
		let count = 0;
		let failAt = Infinity;
		let cleanupFails = false;
		let holdAt = Infinity;
		let nullAt = Infinity;
		let entered = Promise.withResolvers<void>();
		let released = Promise.withResolvers<void>();
		const failure = new Error('Acquisition failed');
		const cleanupFailure = new Error('Cleanup failed');
		globals[key] = () => {
			if (count++ === failAt) throw failure;
			if (count - 1 === nullAt) {
				entered.resolve();
				return released.promise.then(() => null);
			}
			const controller = new AbortController();
			let closing: Promise<void> | undefined;
			const handle = {
				signal: controller.signal,
				close() {
					if (closing) return closing;
					controller.abort();
					return (closing = cleanupFails
						? Promise.reject(cleanupFailure)
						: Promise.resolve());
				},
			};
			acquired.push(handle);
			if (count - 1 === holdAt) {
				entered.resolve();
				return released.promise.then(() => handle);
			}
			return handle;
		};
		try {
			const built = await Bun.build({
				entrypoints: [new URL(`../../../${path}`, import.meta.url).pathname],
				target: 'bun',
				plugins: [
					{
						name: 'resource-acquisition-failures',
						setup(build) {
							build.onResolve({ filter: /^@epicenter\/app\// }, (args) => ({
								path: args.path,
								namespace: 'resources',
							}));
							build.onLoad({ filter: /.*/, namespace: 'resources' }, () => ({
								loader: 'js',
								contents: `const open=globalThis[${JSON.stringify(key)}]; export {open as openLocal, open as openPersonal, open as openLocalBlobs, open as openRemoteBlobs, open as createRecorder, open as openSqlite, open as openSecrets, open as openEpicenterInference, open as openRuntimeInference, open as openLocalConnectionCatalog, open as openAccountConnectionCatalog};`,
							}));
							build.onResolve({ filter: /data\.js$/ }, () => ({
								path: 'data',
								namespace: 'fixture',
							}));
							build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
								loader: 'js',
								contents: `const definition={id:'test.startup'}; export {definition as whisperingDefinition,definition as honeycrispDefinition,definition as mailDefinition,definition as vocabDefinition};`,
							}));
						},
					},
				],
			});
			if (!built.success) throw new AggregateError(built.logs);
			const bundle = join(directory, 'startup.js');
			await Bun.write(bundle, built.outputs[0]!);
			const open = (await import(bundle))[exported] as (
				account: object,
				signal?: AbortSignal,
			) => Promise<{ signal: AbortSignal; close(): Promise<void> }>;
			const successful = await open({});
			const length = acquired.length;
			const closing = successful.close();
			expect(successful.close()).toBe(closing);
			expect(successful.signal.aborted).toBe(true);
			await closing;
			expect(acquired.every((handle) => handle.signal.aborted)).toBe(true);
			for (failAt = 0; failAt < length; failAt++) {
				acquired.length = 0;
				count = 0;
				await expect(open({})).rejects.toBe(failure);
				expect(acquired).toHaveLength(failAt);
				expect(acquired.every((handle) => handle.signal.aborted)).toBe(true);
			}
			acquired.length = 0;
			count = 0;
			failAt = Infinity;
			holdAt = 1;
			const controller = new AbortController();
			const pending = open({}, controller.signal);
			const outcome = pending.catch((cause) => cause);
			await entered.promise;
			controller.abort(new Error('Unmounted'));
			expect(acquired[0]!.signal.aborted).toBe(true);
			expect(acquired[1]!.signal.aborted).toBe(false);
			released.resolve();
			expect(await outcome).toBe(controller.signal.reason);
			expect(acquired[1]!.signal.aborted).toBe(true);
			expect(count).toBe(2);
			holdAt = Infinity;
			if (
				exported === 'openWhisperingResources' ||
				exported === 'openVocabResources'
			) {
				count = 0;
				acquired.length = 0;
				failAt = Infinity;
				nullAt = exported === 'openWhisperingResources' ? 6 : 3;
				entered = Promise.withResolvers<void>();
				released = Promise.withResolvers<void>();
				const cancellation = new AbortController();
				const result = open({}, cancellation.signal).catch((cause) => cause);
				await entered.promise;
				cancellation.abort(new Error('Unmounted during absent runtime'));
				released.resolve();
				expect(await result).toBe(cancellation.signal.reason);
				expect(count).toBe(nullAt + 1);
				expect(acquired.every((handle) => handle.signal.aborted)).toBe(true);
				nullAt = Infinity;
			}
			count = 0;
			failAt = 1;
			cleanupFails = true;
			const error = await open({}).catch((cause) => cause);
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.cause).toBe(failure);
		} finally {
			delete globals[key];
			await rm(directory, { recursive: true, force: true });
		}
	});
