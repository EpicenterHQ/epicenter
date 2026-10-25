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
const { default: WordsViewHost } = await import(
	'./fixtures/WordsViewHost.svelte'
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

test('Show note and stage waits for its own write', async () => {
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
	const gate = Promise.withResolvers<void>();
	host.control.putGate = gate.promise;
	const repaired = '---\ntext: lucid\nnote: clear\nstage: new\ncreatedAt: 2026-01-01\n---\n';
	type(target.querySelector('textarea'), repaired);
	flushSync();
	click(target, 'Show note and stage');
	await until(() => folder.saving, 'repair action write');
	expect(entries.repair.open).toBe('broken');
	gate.resolve();
	await until(() => entries.repair.open === undefined, 'repair action close');
	expect(host.text('entries/broken.md')).toBe(repaired);
	await unmount(mounted);
	target.remove();
	await core.close();
});

test('a failed repair stays visible until Save again lands', async () => {
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
	host.control.failPut.set('entries/broken.md', {
		name: 'StorageFailed',
		message: 'storage refused',
		cause: 'full',
	});
	const repaired = '---\ntext: lucid\nnote: clear\nstage: new\ncreatedAt: 2026-01-01\n---\n';
	type(
		target.querySelector('textarea'),
		repaired,
	);
	await until(() => {
		flushSync();
		return target.textContent?.includes('Not saved:') ?? false;
	}, 'failed repair editor');
	expect((target.querySelector('textarea') as HTMLTextAreaElement).value).toBe(repaired);
	click(target, 'Show note and stage');
	expect(entries.repair.open).toBe('broken');
	host.control.failPut.delete('entries/broken.md');
	click(target, 'Save again');
	await until(() => folder.tables.entries.row('broken')?.issues === null, 'retried repair save');
	flushSync();
	expect(target.textContent).not.toContain('Not saved:');
	click(target, 'Show note and stage');
	await until(() => entries.repair.open === undefined, 'closed repair');
	await unmount(mounted);
	target.remove();
	await core.close();
});

test('switching repairs remounts the editor with the selected file', async () => {
	const { folder, core, host } = await createMemory({
		'entries/a.md': 'broken a',
		'entries/b.md': 'broken b',
	});
	const entries = createEntries(folder);
	entries.repair.start('a');
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(WordsViewHost, { target, props: { folder, entries } });
	flushSync();
	const gate = Promise.withResolvers<void>();
	host.control.putGate = gate.promise;
	type(target.querySelector('textarea[aria-label="File text for entries/a.md"]'), 'changed a');
	entries.repair.start('b');
	flushSync();
	expect(target.querySelector('textarea[aria-label="File text for entries/a.md"]')).toBeNull();
	expect((target.querySelector('textarea[aria-label="File text for entries/b.md"]') as HTMLTextAreaElement).value).toBe('broken b');
	gate.resolve();
	await until(() => host.text('entries/a.md') === 'changed a', 'first repair save');
	flushSync();
	expect((target.querySelector('textarea[aria-label="File text for entries/b.md"]') as HTMLTextAreaElement).value).toBe('broken b');
	await unmount(mounted);
	target.remove();
	await core.close();
});

test('a repair draft recreates a file deleted outside the folder', async () => {
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
	host.outside('entries/broken.md', null, { hint: true });
	await folder.refresh();
	await until(() => folder.file('entries/broken.md') === undefined, 'outside deletion');
	const repaired = '---\ntext: lucid\nnote: clear\nstage: new\ncreatedAt: 2026-01-01\n---\n';
	type(target.querySelector('textarea'), repaired);
	await until(() => host.text('entries/broken.md') === repaired, 'recreated repair file');
	expect(host.text('entries/broken.md')).toBe(repaired);
	expect(folder.tables.entries.row('broken')?.issues).toBeNull();
	await unmount(mounted);
	target.remove();
	await core.close();
});
