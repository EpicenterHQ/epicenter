/**
 * Replaced Notice Mounted Tests
 *
 * Mounts the real `ReplacedNotice` in jsdom over what one save replaced.
 *
 * Key behaviors:
 * - Each replaced value is named: a field or setting with both values, each
 *   competing span of text with its lines, and a whole file
 * - "Restore theirs" and "Dismiss" call back once each
 *
 * Run with `bun run test:mounted`.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { Replaced } from '@epicenter/folder';
import { click } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: ReplacedNotice, describeReplaced } = await import(
	'./replaced-notice.svelte'
);

const replaced: Replaced[] = [
	{ kind: 'field', field: 'title', kept: 'Mine', theirs: 'Theirs' },
	{ kind: 'setting', key: 'theme', kept: 'dark', theirs: undefined },
	{
		kind: 'text',
		part: 'body',
		kept: 'one\nTWO (mine)\nTHREE (mine)\n',
		theirs: 'one\ntwo (theirs)\n',
		regions: [
			{
				line: 1,
				kept: 'TWO (mine)\nTHREE (mine)\n',
				theirs: 'two (theirs)\n',
			},
		],
	},
	{ kind: 'whole', theirs: null },
];

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

test('each replaced value is named with what was kept and what was theirs', () => {
	expect(replaced.flatMap(describeReplaced)).toEqual([
		'title: kept "Mine"; theirs was "Theirs"',
		'theme: kept "dark"; theirs was nothing',
		'Text, lines 2-3: kept "TWO (mine)\nTHREE (mine)"; theirs was "two (theirs)"',
		'The whole file: yours was kept over theirs',
	]);
});

test('Restore theirs and Dismiss call back', () => {
	const calls: string[] = [];
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(ReplacedNotice, {
		target,
		props: {
			replaced,
			subject: 'Milk',
			onRestore: () => calls.push('restore'),
			onDismiss: () => calls.push('dismiss'),
		},
	});
	cleanup.push(() => {
		unmount(component);
		target.remove();
	});
	flushSync();
	expect(target.textContent).toContain(
		'Saved over a change made elsewhere to Milk',
	);
	expect(target.querySelectorAll('li')).toHaveLength(4);
	click(target, 'Restore theirs');
	click(target, 'Dismiss');
	expect(calls).toEqual(['restore', 'dismiss']);
});
