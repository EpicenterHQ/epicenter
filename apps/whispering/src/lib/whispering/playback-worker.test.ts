import { expect, test } from 'bun:test';
import { preparePlaybackWorker } from './playback-worker.js';

for (const previous of [
	null,
	{ scriptURL: 'https://example.test/unrelated.js' },
]) {
	test(`playback waits for its own controlling worker: ${previous ? 'replacement' : 'first install'}`, async () => {
		const oldNavigator = Object.getOwnPropertyDescriptor(
			globalThis,
			'navigator',
		);
		const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
		const events = new EventTarget();
		const serviceWorker = Object.assign(events, {
			controller: previous,
			register: async () => ({}),
		});
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: { serviceWorker },
		});
		Object.defineProperty(globalThis, 'location', {
			configurable: true,
			value: { origin: 'https://example.test' },
		});
		try {
			let ready = false;
			const opening = preparePlaybackWorker().then(() => {
				ready = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(ready).toBe(false);
			serviceWorker.controller = {
				scriptURL: 'https://example.test/epicenter-blob-worker.js',
			};
			serviceWorker.dispatchEvent(new Event('controllerchange'));
			await opening;
			expect(ready).toBe(true);
		} finally {
			if (oldNavigator)
				Object.defineProperty(globalThis, 'navigator', oldNavigator);
			else Reflect.deleteProperty(globalThis, 'navigator');
			if (oldLocation)
				Object.defineProperty(globalThis, 'location', oldLocation);
			else Reflect.deleteProperty(globalThis, 'location');
		}
	});
}
