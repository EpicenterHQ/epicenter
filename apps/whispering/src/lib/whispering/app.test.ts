/** Whispering app acquisition tests over the real Bun Data runtime. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobByteSource,
	type BunBlobRead,
	openBunRecordEpicenter,
} from '@epicenter/data/bun';
import type { RecordEpicenter } from '@epicenter/data/record';
import { Err } from 'wellcrafted/result';
import { whisperingLens } from '../data';
import { openWhisperingApp, type WhisperingAppDependencies } from './app';

function dependencies(
	root: string,
	overrides: Partial<
		WhisperingAppDependencies<BlobByteSource, BunBlobRead>
	> = {},
): WhisperingAppDependencies<BlobByteSource, BunBlobRead> {
	return {
		openEpicenter: () => openBunRecordEpicenter({ directory: root }),
		prepareAudio: (audio) => {
			if (audio.kind !== 'bytes') throw new Error('Unexpected native capture');
			return audio.bytes.stream();
		},
		materializeAudio: (read) => new Response(read).blob(),
		defaultTranscriptionService: 'OpenAI',
		reportBackgroundError: () => undefined,
		...overrides,
	};
}

test('resolves a ready facade with release-local setting defaults', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-ready-'));
	try {
		await using app = await openWhisperingApp(dependencies(root));
		expect(app.settings.get('transcription.service')).toBe('OpenAI');
		expect(app.recordings.count).toBe(0);
		expect(app.recipes.count).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('settings writes are optimistic, subscribed, and durable', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-settings-'));
	try {
		{
			await using app = await openWhisperingApp(dependencies(root));
			let notifications = 0;
			const stop = app.settings.subscribe(() => {
				notifications += 1;
			});
			app.settings.set('recording.pausePlayback', true);
			expect(app.settings.get('recording.pausePlayback')).toBe(true);
			expect(notifications).toBeGreaterThan(0);
			stop();
			await Bun.sleep(10);
		}
		await using reopened = await openWhisperingApp(dependencies(root));
		expect(reopened.settings.get('recording.pausePlayback')).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('nonconforming settings use their defaults and preserve the classified error', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-nonconforming-'));
	const classified = new Error('stored setting is nonconforming');
	const reported: unknown[] = [];
	try {
		const actual = await openBunRecordEpicenter({ directory: root });
		const openEpicenter = async () =>
			({
				bind() {
					const bound = actual.bind({ whispering: whisperingLens });
					const whispering = bound.whispering;
					return {
						...bound,
						whispering: {
							...whispering,
							settings: {
								...whispering.settings,
								recordingPausePlayback: {
									...whispering.settings.recordingPausePlayback,
									get: async () => Err(classified),
								},
							},
						},
					};
				},
				[Symbol.asyncDispose]: () => actual[Symbol.asyncDispose](),
			}) as unknown as RecordEpicenter<BlobByteSource, BunBlobRead>;

		await using app = await openWhisperingApp(
			dependencies(root, {
				openEpicenter,
				reportBackgroundError: (cause) => reported.push(cause),
			}),
		);
		expect(app.settings.get('recording.pausePlayback')).toBe(false);
		expect(app.settings.loadError).toBe(classified);
		expect(reported).toContain(classified);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an Epicenter open failure rejects without a half-open facade', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-failure-'));
	const cause = new Error('open failed');
	try {
		await expect(
			openWhisperingApp(
				dependencies(root, {
					openEpicenter: () => Promise.reject(cause),
				}),
			),
		).rejects.toBe(cause);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('abort wins an in-flight Epicenter acquisition and late open is released', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-abort-'));
	const gate = Promise.withResolvers<void>();
	let disposed = false;
	const controller = new AbortController();
	try {
		const opening = openWhisperingApp(
			dependencies(root, {
				openEpicenter: async () => {
					await gate.promise;
					const epicenter = await openBunRecordEpicenter({ directory: root });
					return {
						...epicenter,
						async [Symbol.asyncDispose]() {
							disposed = true;
							await epicenter[Symbol.asyncDispose]();
						},
					};
				},
			}),
			{ signal: controller.signal },
		);
		controller.abort(new Error('root unmounted'));
		await expect(opening).rejects.toThrow('root unmounted');
		gate.resolve();
		while (!disposed) await Bun.sleep(1);
		expect(Boolean(disposed)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
