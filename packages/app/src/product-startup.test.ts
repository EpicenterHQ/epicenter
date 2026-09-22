/** Product startup keeps successful roots until replacement. Required failure is
 * terminal to the caller; optional inference cannot block recording readiness. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const [path, exported, required] of [
	[
		'apps/whispering/src/lib/whispering/resources.ts',
		'openWhisperingResources',
		3,
	],
	['apps/local-mail/ui/src/lib/resources.ts', 'openMailResources', 3],
	['apps/honeycrisp/src/lib/resources.ts', 'openHoneycrispResources', 2],
	['apps/vocab/src/lib/resources.ts', 'openVocabResources', 2],
] as const)
	test(`${exported} retains roots after required failure and fences departure independently`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'product-startup-'));
		const key = `startup_${crypto.randomUUID()}`;
		const globals = globalThis as unknown as Record<string, unknown>;
		const acquired: Array<{ signal: AbortSignal; close(): Promise<void> }> = [];
		let count = 0;
		let failAt = 1;
		let optionalPending = false;
		const optional = Promise.withResolvers<null>();
		const failure = new Error('Acquisition failed');
		globals[key] = (name: string) => {
			if (
				name.includes('Inference') ||
				name.includes('Transcriber') ||
				name.includes('Catalog')
			)
				return optionalPending ? optional.promise : Promise.reject(failure);
			if (count++ === failAt) throw failure;
			const lifetime = new AbortController();
			const handle = {
				signal: lifetime.signal,
				close: async () => {
					lifetime.abort();
				},
			};
			acquired.push(handle);
			return handle;
		};
		try {
			const names = [
				'openLocal',
				'openPersonal',
				'createRecorder',
				'openSqlite',
				'openSecrets',
				'openEpicenterInference',
				'openRuntimeTranscriber',
				'openLocalConnectionCatalog',
				'openAccountConnectionCatalog',
			];
			const built = await Bun.build({
				entrypoints: [new URL(`../../../${path}`, import.meta.url).pathname],
				target: 'bun',
				plugins: [
					{
						name: 'startup-resources',
						setup(build) {
							build.onResolve({ filter: /^@epicenter\/app\// }, (args) => ({
								path: args.path,
								namespace: 'resources',
							}));
							build.onLoad({ filter: /.*/, namespace: 'resources' }, () => ({
								loader: 'js',
								contents: names
									.map(
										(name) =>
											`export ${name === 'createRecorder' ? '' : 'async '}function ${name}(){return globalThis[${JSON.stringify(key)}](${JSON.stringify(name)})}`,
									)
									.join('\n'),
							}));
							build.onResolve({ filter: /data\.js$/ }, () => ({
								path: 'data',
								namespace: 'fixture',
							}));
							build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
								loader: 'js',
								contents:
									"const definition={id:'test.startup'}; export {definition as whisperingDefinition,definition as honeycrispDefinition,definition as mailDefinition,definition as vocabDefinition};",
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
				signal: AbortSignal,
			) => Promise<{
				signal: AbortSignal;
				inference?: Promise<{ errors: string[] }>;
			}>;
			await expect(open({}, new AbortController().signal)).rejects.toBe(
				failure,
			);
			expect(acquired).toHaveLength(1);
			expect(acquired[0]!.signal.aborted).toBe(false);
			count = 0;
			failAt = Infinity;
			acquired.length = 0;
			optionalPending = true;
			const departure = new AbortController();
			const roots = await open({}, departure.signal);
			expect(acquired).toHaveLength(required);
			expect('close' in roots).toBe(false);
			expect(roots.signal).toBe(departure.signal);
			departure.abort();
			expect(roots.signal.aborted).toBe(true);
			// The data root remains owned by the browser/WebView.
			expect(acquired[0]!.signal.aborted).toBe(false);
			if (exported === 'openWhisperingResources')
				expect(acquired[2]!.signal.aborted).toBe(true);
			if (exported === 'openMailResources')
				expect(acquired.slice(1).every((handle) => handle.signal.aborted)).toBe(
					true,
				);
			optional.resolve(null);
			await roots.inference;
			count = 0;
			acquired.length = 0;
			optionalPending = false;
			const failedOptional = await open({}, new AbortController().signal);
			if (failedOptional.inference)
				expect((await failedOptional.inference).errors).toHaveLength(3);
		} finally {
			delete globals[key];
			await rm(directory, { recursive: true, force: true });
		}
	});
