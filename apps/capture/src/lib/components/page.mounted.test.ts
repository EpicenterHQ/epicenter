/**
 * Mounted Capture Page Tests
 *
 * Confirms the browser entry opens the mirror, displays an empty timeline,
 * and saves a capture through OpenFolder.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { until } from '@epicenter/folder/testing';
import {
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: PageHost } = await import('./fixtures/PageHost.svelte');
setWide(true);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
	document.body.replaceChildren();
});

test('fresh browser opens a timeline with a neutral storage status', async () => {
	globalThis.indexedDB = new IDBFactory();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target });
	cleanup.push(async () => {
		await unmount(view);
	});
	await until(() => {
		flushSync();
		return target.textContent?.includes('New capture') === true;
	});
	expect(target.textContent).toContain('On this device');
	expect(target.textContent).not.toContain('Save version');
});

test('Add from the page writes a capture and opens Add a thought', async () => {
	globalThis.indexedDB = new IDBFactory();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target });
	cleanup.push(async () => {
		await unmount(view);
	});
	await until(() => {
		flushSync();
		return document.getElementById('new-capture') !== null;
	});
	const field = document.getElementById('new-capture');
	if (!(field instanceof HTMLTextAreaElement))
		throw new Error('New capture did not mount');
	type(field, 'From the page');
	field.form?.dispatchEvent(
		new Event('submit', { bubbles: true, cancelable: true }),
	);
	await until(() => {
		flushSync();
		return document.getElementById('new-thought') !== null;
	});
	const capture = document.getElementById('capture-text');
	if (!(capture instanceof HTMLTextAreaElement))
		throw new Error('Capture did not open');
	expect(capture.value).toBe('From the page');
});
