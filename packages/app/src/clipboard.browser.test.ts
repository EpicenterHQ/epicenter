/** The browser leaf reaches the page's Clipboard API at call time, not import time. */
import { afterEach, expect, test } from 'bun:test';
import { clipboard } from './clipboard/browser.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
	if (original) Object.defineProperty(globalThis, 'navigator', original);
	else Reflect.deleteProperty(globalThis, 'navigator');
});

function installNavigatorClipboard(text: { value: string }) {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			clipboard: {
				readText: async () => text.value,
				async writeText(next: string) {
					text.value = next;
				},
			},
		},
	});
}

test('reads and writes through navigator.clipboard', async () => {
	const text = { value: '' };
	installNavigatorClipboard(text);
	expect(await clipboard.readText()).toEqual({ data: null, error: null });
	expect(await clipboard.writeText('page')).toEqual({
		data: undefined,
		error: null,
	});
	expect(text.value).toBe('page');
	expect(await clipboard.readText()).toEqual({ data: 'page', error: null });
});

test('a missing Clipboard API is a ClipboardError, not a throw', async () => {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {},
	});
	expect((await clipboard.readText()).error?.name).toBe('ClipboardRead');
	expect((await clipboard.writeText('x')).error?.name).toBe('ClipboardWrite');
});
