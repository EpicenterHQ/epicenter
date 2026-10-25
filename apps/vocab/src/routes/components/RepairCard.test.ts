import { createMemory, until } from '../../lib/folder.test-support.js';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { createEntries } = await import('../../lib/entries.svelte.js');

const { flushSync, mount, unmount } = await import('svelte');
const { default: RepairCardHost } = await import(
	'./fixtures/RepairCardHost.svelte'
);

test('repair problems follow typed text before its save lands', async () => {
	const { folder, core, host } = await createMemory({
		'entries/broken.md': 'broken frontmatter',
	});
	const entries = createEntries(folder);
	entries.repair.start('broken');
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(RepairCardHost, {
		target,
		props: { folder, entries, id: 'broken' },
	});
	flushSync();
	expect(
		target.querySelector('[aria-label="Problems in the current text"]'),
	).not.toBeNull();
	const gate = Promise.withResolvers<void>();
	host.control.putGate = gate.promise;
	type(
		target.querySelector('textarea'),
		'---\ntext: lucid\nnote: clear\nstage: new\ncreatedAt: 2026-01-01\n---\n',
	);
	flushSync();
	expect(
		target.querySelector('[aria-label="Problems in the current text"]'),
	).toBeNull();
	expect(target.textContent).toContain('Show note and stage');
	gate.resolve();
	await unmount(mounted);
	target.remove();
	await core.close();
});

test('a saved row that is still invalid explains why repair stays open', async () => {
	const { folder, core, host } = await createMemory({
		'entries/broken.md': 'broken frontmatter',
	});
	const entries = createEntries(folder);
	entries.repair.start('broken');
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(RepairCardHost, {
		target,
		props: { folder, entries, id: 'broken' },
	});
	flushSync();
	type(
		target.querySelector('textarea'),
		'---\ntext: lucid\nnote: clear\nstage: new\ncreatedAt: 2026-01-01\n---\n',
	);
	await until(
		() => folder.tables.entries.row('broken')?.issues === null,
		'valid repair save',
	);
	entries.repair.close = async () => {
		host.outside('entries/broken.md', 'invalid again', { hint: true });
		folder.checkpoint();
		await until(() => {
			const row = folder.tables.entries.row('broken');
			return row !== undefined && row.issues !== null;
		}, 'outside invalid row');
		return false;
	};
	flushSync();
	click(target, 'Show note and stage');
	await until(() => {
		flushSync();
		return (
			target.textContent?.includes('The saved file still has problems.') ??
			false
		);
	}, 'invalid saved row explanation');
	expect(entries.repair.open).toBe('broken');
	await unmount(mounted);
	target.remove();
	await core.close();
});
