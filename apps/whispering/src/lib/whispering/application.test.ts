/**
 * Whispering Application Acquisition Tests
 *
 * Locks the transactional boot contract: resolve fully ready or reject fully
 * released, with abort covering both the in-flight and the resolve-after-abort
 * race.
 *
 * Key behaviors:
 * - Success resolves only after the workspace opens and settings hydrate
 * - Any open failure disposes the runtime and rejects
 * - An abort during acquisition releases everything and rejects
 * - A resolve that races an abort still releases
 * - Settings are optimistic with re-read repair and notify subscribers
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { openWhisperingApplication } from './application';

type FakeRuntimeOptions = {
	failFor?: string[];
	openGate?: Promise<void>;
	projectionGate?: Promise<void>;
	projectionGates?: Promise<void>[];
	kvGate?: () => Promise<void>;
	disposeGate?: Promise<void>;
};

function createFakeRuntime({
	failFor = [],
	openGate,
	projectionGate,
	projectionGates = [],
	kvGate,
	disposeGate,
}: FakeRuntimeOptions = {}) {
	const kvValues = new Map<string, unknown>();
	const log: string[] = [];
	let disposed = false;
	let disposeCalls = 0;
	let onRecordsChanged: (workspaceId: string) => void = () => {};
	let projectionCall = 0;
	let kvCalls = 0;
	const waitForProjection = async () => {
		await (projectionGates[projectionCall++] ?? projectionGate);
	};
	const runtime = {
		open: async (definition: { id: string }) => {
			log.push(`open:${definition.id}`);
			await openGate;
			if (failFor.includes(definition.id)) {
				throw new Error(`open failed for ${definition.id}`);
			}
			return {
				id: definition.id,
				tables: {
					recordings: {
						list: async () => {
							await waitForProjection();
							return { rows: [], nonconforming: [] };
						},
					},
					recipes: {
						list: async () => {
							await waitForProjection();
							return { rows: [], nonconforming: [] };
						},
					},
				},
				sql: async () => [],
				sync: null,
				kv: {
					get: async (key: string) => {
						kvCalls += 1;
						await kvGate?.();
						return Ok(kvValues.get(key));
					},
					set: async (key: string, value: unknown) => {
						if (disposed) throw new Error('runtime disposed');
						kvValues.set(key, value);
						return Ok(undefined);
					},
					unset: async (key: string) => {
						kvValues.delete(key);
					},
				},
			} as never;
		},
		[Symbol.asyncDispose]: async () => {
			disposeCalls += 1;
			await disposeGate;
			disposed = true;
			log.push('dispose');
		},
	};
	return {
		runtime,
		kvValues,
		log,
		get disposed() {
			return disposed;
		},
		get disposeCalls() {
			return disposeCalls;
		},
		get projectionCalls() {
			return projectionCall;
		},
		get kvCalls() {
			return kvCalls;
		},
		observeRecordsChanged(listener: (workspaceId: string) => void) {
			onRecordsChanged = listener;
		},
		emitRecordsChanged() {
			onRecordsChanged('epicenter-whispering');
		},
	};
}

const dependencies = (fake: ReturnType<typeof createFakeRuntime>) =>
	({
		createRuntime: (onRecordsChanged: (workspaceId: string) => void) => {
			fake.observeRecordsChanged(onRecordsChanged);
			return fake.runtime;
		},
		defaultTranscriptionService: 'OpenAI',
		reportBackgroundError: () => undefined,
	}) as const;

test('resolves a ready application with hydrated settings', async () => {
	const fake = createFakeRuntime();
	fake.kvValues.set('transcription.service', 'Groq');
	await using app = await openWhisperingApplication(dependencies(fake));
	expect(fake.log).toEqual(['open:epicenter-whispering']);
	// Stored value wins; unset keys fall back to platform defaults.
	expect(app.settings.get('transcription.service')).toBe('Groq');
	expect(app.settings.get('recording.autoUpload')).toBe(
		app.settings.getDefault('recording.autoUpload'),
	);
});

test('a failed workspace open rejects fully released', async () => {
	const fake = createFakeRuntime({ failFor: ['epicenter-whispering'] });
	await expect(openWhisperingApplication(dependencies(fake))).rejects.toThrow(
		'open failed for epicenter-whispering',
	);
	expect(fake.disposed).toBe(true);
});

test('does not resolve before recordings and recipes are hydrated', async () => {
	const gate = Promise.withResolvers<void>();
	const fake = createFakeRuntime({ projectionGate: gate.promise });
	let settled = false;
	const opening = openWhisperingApplication(dependencies(fake)).then((app) => {
		settled = true;
		return app;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	gate.resolve();
	await using app = await opening;
	expect(app.recordings.count).toBe(0);
	expect(app.recipes.count).toBe(0);
});

test('boot follows an invalidation that lands during initial projection hydration', async () => {
	const initial = Promise.withResolvers<void>();
	const replacement = Promise.withResolvers<void>();
	const fake = createFakeRuntime({
		projectionGates: [
			initial.promise,
			initial.promise,
			replacement.promise,
			replacement.promise,
		],
	});
	let settled = false;
	const opening = openWhisperingApplication(dependencies(fake)).then((app) => {
		settled = true;
		return app;
	});
	while (fake.projectionCalls < 2) await Promise.resolve();
	fake.emitRecordsChanged();
	while (fake.projectionCalls < 4) await Promise.resolve();
	initial.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	replacement.resolve();
	await using app = await opening;
	expect(app.recordings.count).toBe(0);
});

test('boot follows an invalidation that lands during settings hydration', async () => {
	const initial = Promise.withResolvers<void>();
	const replacement = Promise.withResolvers<void>();
	let currentGate = initial.promise;
	const fake = createFakeRuntime({ kvGate: () => currentGate });
	let settled = false;
	const opening = openWhisperingApplication(dependencies(fake)).then((app) => {
		settled = true;
		return app;
	});
	while (fake.kvCalls === 0) await Promise.resolve();
	currentGate = replacement.promise;
	fake.emitRecordsChanged();
	initial.resolve();
	await Promise.resolve();
	await Promise.resolve();
	expect(settled).toBe(false);
	replacement.resolve();
	await using app = await opening;
	expect(app.settings.loadError).toBeNull();
});

test('projection collection identities change only after refresh', async () => {
	const fake = createFakeRuntime();
	await using app = await openWhisperingApplication(dependencies(fake));
	expect(app.recordings.sorted).toBe(app.recordings.sorted);
	expect(app.recipes.pickable).toBe(app.recipes.pickable);
});

test('an abort during acquisition releases and rejects', async () => {
	const gate = Promise.withResolvers<void>();
	const fake = createFakeRuntime({ openGate: gate.promise });
	const controller = new AbortController();
	const opening = openWhisperingApplication(dependencies(fake), {
		signal: controller.signal,
	});
	controller.abort(new Error('root unmounted'));
	await Promise.resolve();
	expect(fake.disposed).toBe(true);
	gate.resolve();
	await expect(opening).rejects.toThrow('root unmounted');
	expect(fake.disposed).toBe(true);
});

test('after resolve the caller owns application disposal', async () => {
	const fake = createFakeRuntime();
	const controller = new AbortController();
	const app = await openWhisperingApplication(dependencies(fake), {
		signal: controller.signal,
	});
	expect(fake.disposed).toBe(false);
	controller.abort();
	await Promise.resolve();
	expect(fake.disposed).toBe(false);
	await app[Symbol.asyncDispose]();
	expect(fake.disposed).toBe(true);
});

test('concurrent disposal joins the same runtime close', async () => {
	const gate = Promise.withResolvers<void>();
	const fake = createFakeRuntime({ disposeGate: gate.promise });
	const app = await openWhisperingApplication(dependencies(fake));
	let secondSettled = false;
	const first = app[Symbol.asyncDispose]();
	const second = app[Symbol.asyncDispose]().then(() => {
		secondSettled = true;
	});
	await Promise.resolve();
	expect(fake.disposeCalls).toBe(1);
	expect(secondSettled).toBe(false);
	gate.resolve();
	await Promise.all([first, second]);
	expect(secondSettled).toBe(true);
});

test('settings writes are optimistic and notify subscribers', async () => {
	const fake = createFakeRuntime();
	await using app = await openWhisperingApplication(dependencies(fake));
	let notified = 0;
	const unsubscribe = app.settings.subscribe(() => {
		notified += 1;
	});
	app.settings.set('recording.autoUpload', true);
	expect(app.settings.get('recording.autoUpload')).toBe(true);
	expect(notified).toBe(1);
	unsubscribe();
});
