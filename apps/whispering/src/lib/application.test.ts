import { expect, test } from 'bun:test';
import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import type { WhisperingAppHandle } from './whispering/app.js';
import { attachApplication, getApp, getSelections } from './application.js';

test('only the mounted shell publishes operations access, including across remount', () => {
	expect(() => getApp()).toThrow();
	expect(() => getSelections()).toThrow();
	const lifetime = new AbortController();
	const app = { signal: lifetime.signal } as WhisperingAppHandle;
	const selections = {} as InferenceSelections;
	const detach = attachApplication(app, selections);
	expect(getApp()).toBe(app);
	expect(getSelections()).toBe(selections);
	expect(() => attachApplication(app, selections)).toThrow('already has');
	lifetime.abort();
	expect(() => getApp()).toThrow();
	expect(() => getSelections()).toThrow();
	detach();
	expect(() => getApp()).toThrow();
	const next = { signal: new AbortController().signal } as WhisperingAppHandle;
	const release = attachApplication(next, selections);
	expect(getApp()).toBe(next);
	release();
});
