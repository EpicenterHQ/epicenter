/** Real browser App lifetime, with one opt-in document cleanup failure. */
import { defineApp, defineTable, field } from '../../../src/index.js';
import { openLocal } from '../../../src/open.js';
import { indexedDbStoreRuntime as resources } from '../../../src/platform/documents.js';

const definition = defineApp({
	id:
		new URL(location.href).searchParams.get('appId') ??
		'so.epicenter.admission-evidence',
	tables: { notes: defineTable({ title: field.string() }) },
	kv: {},
});
let failCleanup = false;
let cleanupAttempts = 0;
let failOpening = false;
let blockOpening = false;
let openingErrors: string[] = [];
const runtime = {
	...resources,
	async data(...args: Parameters<typeof resources.data>) {
		if (blockOpening) await new Promise(() => {});
		const result = await resources.data(...args);
		if (result.error) return result;
		const port = result.data;
		return {
			...result,
			data: {
				...port,
				get loaded() {
					if (failOpening)
						throw new Error('Injected document hydration failure');
					return port.loaded;
				},
				async dispose() {
					cleanupAttempts++;
					if (failCleanup) throw new Error('Injected document cleanup failure');
					await port.dispose?.();
				},
			},
		};
	},
};
let app: Awaited<ReturnType<typeof openLocal<typeof definition>>> | undefined;

Object.assign(globalThis, {
	async openEvidence() {
		try {
			app = await openLocal(definition, { runtime });
			return 'ready';
		} catch (error) {
			openingErrors = (
				error instanceof AggregateError ? error.errors : [error]
			).map((cause: { name: string }) => cause.name);
			return (error as { name: string }).name;
		}
	},
	openingErrorsEvidence: () => openingErrors,
	cleanupAttemptsEvidence: () => cleanupAttempts,
	async closeEvidence() {
		try {
			await app?.close();
			return 'closed';
		} catch {
			return 'cleanup-failed';
		}
	},
	async writeEvidence() {
		const row = app!.tables.notes.create({ title: 'retained' });
		await app!.persistence.flush();
		return row.id;
	},
	readEvidence() {
		return app!.tables.notes
			.ids()
			.map((id) => app!.tables.notes.get(id)?.title);
	},
	setOpeningFailure(value: boolean) {
		failOpening = value;
	},
	setOpeningBlocked(value: boolean) {
		blockOpening = value;
	},
	setCleanupFailure(value: boolean) {
		failCleanup = value;
	},
});

/** Memory factories must remain isolated without replacing native browser globals. */
Object.assign(globalThis, {
	async memoryCoexistenceEvidence() {
		const nativeNames = Reflect.ownKeys(globalThis).filter(
			(key): key is string =>
				typeof key === 'string' &&
				(key.startsWith('IDB') || key === 'indexedDB'),
		);
		const nativeGlobals = nativeNames.map((name) =>
			Reflect.get(globalThis, name),
		);
		const { createMemoryStoreRuntime } = await import(
			'../../../src/testing.js'
		);
		const isolatedDefinition = defineApp({
			id: 'so.epicenter.memory-coexistence',
			tables: { notes: defineTable({ title: field.string() }) },
			kv: {},
		});
		const firstRuntime = createMemoryStoreRuntime();
		const secondRuntime = createMemoryStoreRuntime();
		const native = await openLocal(isolatedDefinition);
		let first = await openLocal(isolatedDefinition, { runtime: firstRuntime });
		let second = await openLocal(isolatedDefinition, {
			runtime: secondRuntime,
		});
		function check(held: boolean, message: string) {
			if (!held) throw new Error(message);
		}
		function titles(opened: typeof native) {
			return opened.tables.notes
				.ids()
				.map((id) => opened.tables.notes.get(id)?.title);
		}
		try {
			for (const [opened, title] of [
				[native, 'native'],
				[first, 'memory-a'],
				[second, 'memory-b'],
			] as const) {
				opened.tables.notes.create({ title });
				await opened.persistence.flush();
			}
			await first.close();
			await second.close();
			first = await openLocal(isolatedDefinition, { runtime: firstRuntime });
			second = await openLocal(isolatedDefinition, { runtime: secondRuntime });
			for (const [opened, title] of [
				[native, 'native'],
				[first, 'memory-a'],
				[second, 'memory-b'],
			] as const) {
				check(
					JSON.stringify(titles(opened)) === JSON.stringify([title]),
					'Document reopen crossed runtime storage',
				);
			}
			check(
				nativeNames.every(
					(name, index) =>
						Reflect.get(globalThis, name) === nativeGlobals[index],
				),
				'Memory runtime changed native IndexedDB globals',
			);
			return 'native and two memory runtimes preserve globals and isolate documents';
		} finally {
			await Promise.all([native.close(), first.close(), second.close()]);
			await firstRuntime.dispose();
			await secondRuntime.dispose();
			check(
				nativeNames.every(
					(name, index) =>
						Reflect.get(globalThis, name) === nativeGlobals[index],
				),
				'Memory disposal changed native IndexedDB globals',
			);
		}
	},
});
