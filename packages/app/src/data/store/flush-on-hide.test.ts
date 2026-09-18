/**
 * The hide hook, tested against a page that is not there and a page that is.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { persistOnHide } from './flush-on-hide.js';

type Listener = () => void;

/** A minimal page, in the shape `flush-on-hide.ts` declares it assumes. */
function installPage(): {
	hide(): void;
	show(): void;
	pagehide(): void;
	listeners(): number;
} {
	const doc: Record<string, Set<Listener>> = {};
	const win: Record<string, Set<Listener>> = {};
	let visibility = 'visible';
	const bind = (bag: Record<string, Set<Listener>>) => ({
		addEventListener: (type: string, listener: Listener) => {
			(bag[type] ??= new Set()).add(listener);
		},
		removeEventListener: (type: string, listener: Listener) => {
			bag[type]?.delete(listener);
		},
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			...bind(doc),
			get visibilityState() {
				return visibility;
			},
		},
	});
	Object.assign(globalThis, bind(win));
	const fire = (bag: Record<string, Set<Listener>>, type: string) => {
		for (const listener of [...(bag[type] ?? [])]) listener();
	};
	return {
		hide() {
			visibility = 'hidden';
			fire(doc, 'visibilitychange');
		},
		show() {
			visibility = 'visible';
			fire(doc, 'visibilitychange');
		},
		pagehide: () => fire(win, 'pagehide'),
		listeners: () =>
			(doc.visibilitychange?.size ?? 0) + (win.pagehide?.size ?? 0),
	};
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, 'document');
});

describe('a runtime with no page', () => {
	test('registers nothing and disposes cleanly', () => {
		let calls = 0;
		const stop = persistOnHide(() => {
			calls += 1;
		});
		stop();
		expect(calls).toBe(0);
	});
});

describe('a page that hides', () => {
	test('hiding persists', () => {
		const page = installPage();
		let calls = 0;
		persistOnHide(() => {
			calls += 1;
		});
		page.hide();
		expect(calls).toBe(1);
	});

	test('coming BACK does not persist, which is the whole point of the guard', () => {
		// `visibilitychange` fires in both directions. Without the guard every
		// return to the tab would write the document again for nothing.
		const page = installPage();
		let calls = 0;
		persistOnHide(() => {
			calls += 1;
		});
		page.hide();
		page.show();
		expect(calls).toBe(1);
	});

	test('a bfcache navigation persists, and needs no guard', () => {
		const page = installPage();
		let calls = 0;
		persistOnHide(() => {
			calls += 1;
		});
		page.pagehide();
		expect(calls).toBe(1);
	});

	test('both firing costs one redundant write and misses nothing', () => {
		// The deliberate choice: listen to both, do the work twice, be wrong on
		// the side that loses no data.
		const page = installPage();
		let calls = 0;
		persistOnHide(() => {
			calls += 1;
		});
		page.hide();
		page.pagehide();
		expect(calls).toBe(2);
	});

	test('disposing removes both listeners', () => {
		const page = installPage();
		let calls = 0;
		const stop = persistOnHide(() => {
			calls += 1;
		});
		expect(page.listeners()).toBe(2);
		stop();
		expect(page.listeners()).toBe(0);
		page.hide();
		page.pagehide();
		expect(calls).toBe(0);
	});

	test('a persist that throws does not escape into the teardown', () => {
		const page = installPage();
		persistOnHide(() => Promise.reject(new Error('storage is gone')));
		expect(() => page.hide()).not.toThrow();
	});
});
