/** Device KV imports legacy choices once and keeps reset choices across reopening. */
import { afterEach, expect, test } from 'bun:test';
import { openLocal } from '@epicenter/app/open';
import { createMemoryStoreRuntime } from '@epicenter/app/testing';
import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
import type { AccountIdentity } from '@epicenter/principal';
import { whisperingDefinition } from '../data.js';
import { DEVICE_DEFAULTS } from '../operations/settings.js';
import {
	getInferenceTarget,
	importLegacyInferenceSelections,
} from './inference.js';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
	if (originalWindow)
		Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
});

function browser() {
	const values = new Map<string, string>();
	const listeners = new Set<unknown>();
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			localStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => {
					values.set(key, value);
				},
			},
			addEventListener: (_type: string, listener: unknown) =>
				listeners.add(listener),
			removeEventListener: (_type: string, listener: unknown) =>
				listeners.delete(listener),
		},
	});
	return { values, listeners };
}

test('matching unavailable targets import once, survive reopening, and never resurrect after reset', async () => {
	const { values, listeners } = browser();
	{
		using legacy = createBrowserInferenceSelections('whispering');
		legacy.set('transcription', {
			connectionId: 'removed-provider',
			model: 'speech',
		});
		legacy.set('completion', { connectionId: 'text-provider', model: 'text' });
	}
	const oldBytes = [...values.entries()];
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	app.kv.update({
		transcriptionModel: 'speech',
		completionModel: 'text',
	});
	importLegacyInferenceSelections(app.kv);
	expect(getInferenceTarget(app.kv, 'transcription')).toEqual({
		connectionId: 'removed-provider',
		model: 'speech',
	});
	expect(getInferenceTarget(app.kv, 'completion')).toEqual({
		connectionId: 'text-provider',
		model: 'text',
	});
	expect(listeners.size).toBe(0);
	expect([...values.entries()]).toEqual(oldBytes);
	await app.close();
	const reopened = await openLocal(whisperingDefinition, { runtime });
	importLegacyInferenceSelections(reopened.kv);
	expect(getInferenceTarget(reopened.kv, 'transcription')?.connectionId).toBe(
		'removed-provider',
	);
	reopened.kv.update(DEVICE_DEFAULTS);
	await reopened.close();
	const reset = await openLocal(whisperingDefinition, { runtime });
	importLegacyInferenceSelections(reset.kv);
	expect(getInferenceTarget(reset.kv, 'transcription')).toBeNull();
	expect(getInferenceTarget(reset.kv, 'completion')).toBeNull();
	expect(reset.kv.get('completionConnection')).toBeNull();
	await reset.close();
});

test('model mismatch stays unselected and initialized choices are not overwritten', async () => {
	browser();
	{
		using legacy = createBrowserInferenceSelections('whispering');
		legacy.set('transcription', { connectionId: 'old', model: 'old-model' });
		legacy.set('completion', { connectionId: 'old-text', model: 'text' });
	}
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	app.kv.update({
		transcriptionModel: 'new-model',
		completionModel: 'text',
		completionConnection: 'chosen',
	});
	importLegacyInferenceSelections(app.kv);
	expect(getInferenceTarget(app.kv, 'transcription')).toBeNull();
	expect(app.kv.get('transcriptionModel')).toBe('new-model');
	expect(getInferenceTarget(app.kv, 'completion')?.connectionId).toBe('chosen');
	await app.close();
});

test('legacy completion default is captured explicitly when its model was never stored', async () => {
	browser();
	{
		using legacy = createBrowserInferenceSelections('whispering');
		legacy.set('completion', {
			connectionId: 'chosen',
			model: 'gemini-2.5-flash',
		});
	}
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	importLegacyInferenceSelections(app.kv);
	expect(getInferenceTarget(app.kv, 'completion')).toEqual({
		connectionId: 'chosen',
		model: 'gemini-2.5-flash',
	});
	await app.close();
});

test('malformed legacy bytes initialize no destination and leave no observer', async () => {
	const { values, listeners } = browser();
	{
		using legacy = createBrowserInferenceSelections('whispering');
		legacy.set('completion', { connectionId: 'old', model: 'text' });
	}
	for (const key of values.keys()) values.set(key, '{');
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	importLegacyInferenceSelections(app.kv);
	expect(app.kv.get('transcriptionConnection')).toBeNull();
	expect(app.kv.get('completionConnection')).toBeNull();
	expect(listeners.size).toBe(0);
	await app.close();
});

test('import reads only the captured account partition', async () => {
	browser();
	const first = {
		authorityId: 'https://example.com',
		principalId: 'A',
	} as AccountIdentity;
	const second = { ...first, principalId: 'B' } as AccountIdentity;
	{
		using legacy = createBrowserInferenceSelections('whispering', first);
		legacy.set('transcription', { connectionId: 'account-A', model: 'speech' });
	}
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	app.kv.update({ transcriptionModel: 'speech' });
	importLegacyInferenceSelections(app.kv, second);
	expect(getInferenceTarget(app.kv, 'transcription')).toBeNull();
	await app.close();
});

test('an empty legacy model leaves the workflow unselected', async () => {
	browser();
	{
		using legacy = createBrowserInferenceSelections('whispering');
		legacy.set('transcription', { connectionId: 'old', model: '' });
	}
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	importLegacyInferenceSelections(app.kv);
	expect(getInferenceTarget(app.kv, 'transcription')).toBeNull();
	await app.close();
});
