/** Whispering app acquisition tests over the real Bun Data runtime. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobStore } from '@epicenter/blobs';
import { openBunEpicenter } from '@epicenter/data/runtime/bun';
import { Ok } from 'wellcrafted/result';
import { openWhisperingApp, type WhisperingAppDependencies } from './app';

const local: BlobStore = {
	async put() {
		return Ok(undefined);
	},
	async get() {
		return Ok(new Blob());
	},
	async stat() {
		return Ok({ size: 0, contentType: 'application/octet-stream' });
	},
	async delete() {
		return Ok(undefined);
	},
};

function dependencies(
	root: string,
	overrides: Partial<WhisperingAppDependencies> = {},
): WhisperingAppDependencies {
	return {
		openEpicenter: () => openBunEpicenter({ directory: root, owner: null }),
		blobs: { local, remote: null },
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
		expect(app.settings.get('recording.autoUpload')).toBe(false);
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
			app.settings.set('recording.autoUpload', true);
			expect(app.settings.get('recording.autoUpload')).toBe(true);
			expect(notifications).toBeGreaterThan(0);
			stop();
			await Bun.sleep(10);
		}
		await using reopened = await openWhisperingApp(dependencies(root));
		expect(reopened.settings.get('recording.autoUpload')).toBe(true);
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
					const epicenter = await openBunEpicenter({ directory: root, owner: null });
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
