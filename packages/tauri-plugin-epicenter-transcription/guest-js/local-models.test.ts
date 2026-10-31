/**
 * Activation intent tests. Gated command replies expose every point where a
 * departed page or stopped request could otherwise activate a model later.
 * Transfer identity protects a newer request from late progress and cleanup.
 */
import '../../svelte/src/svelte-modules.test-support.js';
import { expect, mock, test } from 'bun:test';
import type { Channel } from '@tauri-apps/api/core';
import type {
	CatalogError,
	DownloadProgress,
	ModelInfo,
} from './bindings.gen.js';
import type { LocalModelCommands } from './local-models.svelte.js';

mock.module('@tauri-apps/api/core', () => ({
	invoke: () => {
		throw new Error('No native calls in controller tests');
	},
	Channel: class {
		onmessage = (_progress: DownloadProgress) => {};
	},
}));
const { createLocalModels } = await import('./local-models.svelte.js');
const ok = { data: null, error: null } as const;
const model: ModelInfo = {
	id: 'model',
	name: 'Model',
	description: '',
	sizeBytes: 1,
	supportsPrompt: true,
	supportsLanguage: true,
	recommended: true,
	downloaded: false,
};
function at<T>(items: T[], index: number): T {
	const value = items[index];
	if (value === undefined) throw new Error(`Missing fake reply ${index}`);
	return value;
}
const flush = async () => {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
};

function fixture() {
	const scans: ReturnType<typeof Promise.withResolvers<ModelInfo[]>>[] = [];
	const downloads: {
		reply: ReturnType<
			typeof Promise.withResolvers<
				Awaited<ReturnType<LocalModelCommands['downloadModel']>>
			>
		>;
		channel: Channel<DownloadProgress>;
	}[] = [];
	const activated: string[] = [];
	const order: string[] = [];
	const commands: LocalModelCommands = {
		listModels: () => {
			const reply = Promise.withResolvers<ModelInfo[]>();
			scans.push(reply);
			return reply.promise;
		},
		getActiveModel: async () => null,
		getUnloadPolicy: async () => 'after_5_minutes',
		setActiveModel: async (id) => {
			activated.push(id ?? 'none');
			order.push('activate');
			return ok;
		},
		setUnloadPolicy: async () => ok,
		revealModel: async () => ok,
		downloadModel: (_id, channel) => {
			const reply =
				Promise.withResolvers<
					Awaited<ReturnType<LocalModelCommands['downloadModel']>>
				>();
			downloads.push({ reply, channel });
			return reply.promise;
		},
	};
	const controller = createLocalModels(commands);
	return { controller, commands, scans, downloads, activated, order };
}
const installed = [{ ...model, downloaded: true }];

for (const stage of [
	'pre-check',
	'already-installed',
	'download',
	'post-download',
] as const) {
	test(`Stop during ${stage} prevents activation`, async () => {
		const f = fixture();
		const intent = f.controller.downloadAndActivate(model);
		if (stage === 'pre-check') {
			f.controller.stop(model);
			at(f.scans, 0).resolve([model]);
		} else if (stage === 'already-installed') {
			// The refresh has answered, but the intent has not consumed its answer.
			at(f.scans, 0).resolve(installed);
			queueMicrotask(() => f.controller.stop(model));
		} else {
			at(f.scans, 0).resolve([model]);
			await flush();
			if (stage === 'download') f.controller.stop(model);
			at(f.downloads, 0).reply.resolve(ok);
			await flush();
			if (stage === 'post-download') f.controller.stop(model);
			at(f.scans, 1).resolve(installed);
		}
		await intent;
		expect(f.activated).toEqual([]);
		if (stage === 'download' || stage === 'post-download') {
			expect(f.controller.stateOf(at(f.controller.models, 0))).toEqual({
				type: 'ready',
			});
		}
		f.controller.dispose();
	});
}

test('dispose before download success never activates', async () => {
	const f = fixture();
	const intent = f.controller.downloadAndActivate(model);
	at(f.scans, 0).resolve([model]);
	await flush();
	f.controller.dispose();
	at(f.downloads, 0).reply.resolve(ok);
	await intent;
	expect(f.activated).toEqual([]);
});

for (const name of ['Busy', 'DownloadingElsewhere'] as const) {
	test(`a new mount shows the native ${name} answer`, async () => {
		const f = fixture();
		f.controller.dispose();
		f.controller = createLocalModels(f.commands);
		const intent = f.controller.downloadAndActivate(model);
		at(f.scans, 0).resolve([model]);
		await flush();
		const error: CatalogError = { name, message: 'native detail' };
		at(f.downloads, 0).reply.resolve({ data: null, error });
		await intent;
		expect(f.controller.error).toBe(
			name === 'Busy'
				? 'This model is already downloading. It will show as downloaded when it finishes.'
				: 'Another app on this computer is downloading this model.',
		);
		expect(f.activated).toEqual([]);
		f.controller.dispose();
	});
}

test('late progress and finally from an old intent leave its replacement intact', async () => {
	const f = fixture();
	const first = f.controller.downloadAndActivate(model);
	at(f.scans, 0).resolve([model]);
	await flush();
	f.controller.stop(model);
	expect(f.controller.stateOf(model)).toEqual({ type: 'not-downloaded' });
	const second = f.controller.download(model);
	at(f.scans, 1).resolve([model]);
	await flush();
	at(f.downloads, 1).channel.onmessage({ bytesReceived: 25, totalBytes: 100 });
	at(f.downloads, 0).channel.onmessage({ bytesReceived: 99, totalBytes: 100 });
	expect(f.controller.stateOf(model)).toEqual({
		type: 'downloading',
		progress: 25,
	});
	at(f.downloads, 0).reply.resolve(ok);
	await flush();
	at(f.scans, 2).resolve([model]);
	await first;
	expect(f.controller.stateOf(model)).toEqual({
		type: 'downloading',
		progress: 25,
	});
	f.controller.stop(model);
	at(f.downloads, 1).reply.resolve({
		data: null,
		error: { name: 'Busy', message: '' },
	});
	await second;
	expect(f.activated).toEqual([]);
	f.controller.dispose();
});

test('activation is submitted before a Stop microtask after the final refresh', async () => {
	const f = fixture();
	const intent = f.controller.downloadAndActivate(model);
	at(f.scans, 0).resolve([model]);
	await flush();
	at(f.downloads, 0).reply.resolve(ok);
	await flush();
	// Refresh reads disk presence once; the intent's success check reads it again.
	// Schedule Stop when that success is observed, before activation is called.
	let reads = 0;
	const downloaded = {
		...model,
		get downloaded() {
			if (++reads === 1) {
				f.order.push('success');
				queueMicrotask(() => {
					f.order.push('stop');
					f.controller.stop(model);
				});
			}
			return true;
		},
	};
	at(f.scans, 1).resolve([downloaded]);
	await flush();
	expect(f.order).toEqual(['success', 'activate', 'stop']);
	at(f.scans, 2).resolve(installed);
	await intent;
	expect(f.activated).toEqual(['model']);
	f.controller.dispose();
});

test('an older refresh cannot replace a completed activation or publish its error', async () => {
	const f = fixture();
	let active: Awaited<ReturnType<LocalModelCommands['getActiveModel']>> = null;
	f.commands.getActiveModel = async () => active;
	f.commands.setActiveModel = async (id) => {
		active = {
			id: id!,
			name: id!,
			installed: true,
			supportsPrompt: true,
			supportsLanguage: true,
		};
		return ok;
	};
	const old = f.controller.refresh();
	const activating = f.controller.activate(model);
	await flush();
	at(f.scans, 1).resolve(installed);
	await activating;
	expect(f.controller.active?.id).toBe(model.id);
	at(f.scans, 0).reject(new Error('obsolete scan'));
	await old;
	expect(f.controller.active?.id).toBe(model.id);
	expect(f.controller.error).toBeNull();
	f.controller.dispose();
});

test('a superseded download precheck still returns its own scan and retains activation intent', async () => {
	const f = fixture();
	const intent = f.controller.downloadAndActivate(model);
	const newer = f.controller.refresh();
	at(f.scans, 1).resolve([model]);
	await newer;
	at(f.scans, 0).resolve(installed);
	await flush();
	expect(f.activated).toEqual([model.id]);
	expect(f.downloads).toHaveLength(0);
	at(f.scans, 2).resolve(installed);
	await intent;
	f.controller.dispose();
});

test('Stop during precheck starts no download and makes no background claim, including after a late failure', async () => {
	const f = fixture();
	const first = f.controller.downloadAndActivate(model);
	f.controller.stop(model);
	at(f.scans, 0).resolve([model]);
	await first;
	expect(f.downloads).toHaveLength(0);
	expect(f.controller.stateOf(model)).toEqual({ type: 'not-downloaded' });
	const next = f.controller.download(model);
	at(f.scans, 1).resolve([model]);
	await flush();
	f.controller.stop(model);
	at(f.downloads, 0).reply.resolve({
		data: null,
		error: { name: 'DownloadFailed', message: 'failed after Stop' },
	});
	await next;
	expect(f.controller.stateOf(model)).toEqual({ type: 'not-downloaded' });
	expect(f.controller.error).toBeNull();
	f.controller.dispose();
});
