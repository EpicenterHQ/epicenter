import { createMemory } from '../../lib/folder.test-support.js';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { type } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

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
