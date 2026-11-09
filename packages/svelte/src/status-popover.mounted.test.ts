/**
 * Status Popover Mounted Tests
 *
 * Mounts the real `StatusPopover`, open, in jsdom with one app row and a
 * footer action.
 *
 * Key behaviors:
 * - The summary button names the summary line
 * - Each status line is a row under its name and test id, with its detail;
 *   the app's own rows follow the lines, and its actions sit in the footer
 *
 * Run with `bun run test`.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { StatusLine } from './status-line.js';
import { click } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: StatusPopoverHost } = await import(
	'./fixtures/StatusPopoverHost.svelte'
);

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

const saved: StatusLine = { label: 'Saved', tone: 'good' };
const failed: StatusLine = {
	label: 'Version failed',
	detail: 'disk full\nYour files are still saved.',
	tone: 'error',
};

test('the details show each line under its name, then the app rows and actions', () => {
	let actions = 0;
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(StatusPopoverHost, {
		target,
		props: {
			summary: failed,
			details: [
				{ name: 'Saves', testid: 'status-saves', line: saved },
				{ name: 'Versions', testid: 'status-history', line: failed },
			],
			onAction: () => actions++,
		},
	});
	cleanup.push(() => {
		unmount(component);
		target.remove();
	});
	flushSync();

	const summary = document.querySelector('[data-testid="status-summary"]');
	expect(summary?.getAttribute('aria-label')).toBe(
		'Status: Version failed. Show details',
	);
	expect(
		[...document.querySelectorAll('dt')].map((name) => name.textContent),
	).toEqual(['Saves', 'Versions', 'Folder']);
	expect(
		document.querySelector('[data-testid="status-saves"]')?.textContent?.trim(),
	).toBe('Saved');
	const versions = document.querySelector('[data-testid="status-history"]');
	expect(versions?.textContent?.trim()).toBe('Version failed');
	expect(versions?.parentElement?.textContent).toContain('disk full');
	expect(
		document.querySelector('[data-testid="status-folder"]')?.textContent,
	).toBe('/notes');
	click(document.body, 'Save version');
	expect(actions).toBe(1);
});
