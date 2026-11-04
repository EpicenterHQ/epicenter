/**
 * Browser microphone preferences. Malformed device settings remain visible
 * rather than overwritten.
 */
import { afterEach, expect, test } from 'bun:test';
import type { Client } from '@epicenter/definition/contract';
import type { Whispering } from '../contract.js';

// Compile the Vite build flag for this adapter test; no microphone is opened.
Bun.plugin({
	name: 'browser-services-build-flag',
	setup(build) {
		build.onLoad({ filter: /\/platform\/browser\.ts$/ }, async ({ path }) => ({
			contents: new Bun.Transpiler({
				loader: 'ts',
				define: { 'import.meta.env.DEV': 'false' },
			}).transformSync(await Bun.file(path).text()),
			loader: 'js',
		}));
	},
});

const { createServices } = await import('./browser.js');
/** The browser's services need nothing of the client they are made over. */
const client = {} as Client<Whispering>;

const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'localStorage',
);
const originalLocation = Object.getOwnPropertyDescriptor(
	globalThis,
	'location',
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const [name, descriptor] of [
		['localStorage', originalStorage],
		['location', originalLocation],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

async function preferences(getItem: (key: string) => string | null) {
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('http://localhost:5199'),
	});
	return createServices(client).preferences;
}

test('missing and valid microphone preferences retain their meaning', async () => {
	let saved: string | null = null;
	const reader = await preferences((key) => {
		expect(key).toBe('whispering.microphone');
		return saved;
	});
	expect(await reader.microphone()).toBeUndefined();
	saved = JSON.stringify({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
	expect(await reader.microphone()).toEqual({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
});

test('a refused storage read rejects instead of selecting System default', async () => {
	const reader = await preferences(() => {
		throw new Error('Storage access refused');
	});
	await expect(reader.microphone()).rejects.toThrow('Storage access refused');
});

test('malformed microphone JSON rejects instead of selecting System default', async () => {
	const reader = await preferences(() => '{broken');
	await expect(reader.microphone()).rejects.toBeInstanceOf(SyntaxError);
});
