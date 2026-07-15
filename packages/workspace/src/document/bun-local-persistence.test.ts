import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { attachPlainText } from './attach-plain-text.js';
import { bunLocalPersistence } from './bun-local-persistence.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './workspace.js';

const notes = defineTable({
	id: field.string(),
	title: field.string(),
}).docs({ body: attachPlainText });

const model = defineWorkspace({
	id: 'bun-local-notes',
	name: 'Bun Local Notes',
	tables: { notes },
	kv: {},
});

function testDir(): string {
	return mkdtempSync(join(tmpdir(), 'workspace-bun-local-'));
}

describe('bunLocalPersistence', () => {
	test('replays root rows and child docs from a shared dir', async () => {
		const dir = testDir();
		{
			const workspace = model.connect(
				{ kind: 'local' },
				{
					persistence: bunLocalPersistence({ dir }),
				},
			);
			await workspace.storage.whenLoaded;
			workspace.tables.notes.set({ id: 'note-1', title: 'first' });
			const body = workspace.tables.notes.docs.body.open('note-1');
			await body.whenLoaded;
			body.write('durable body');
			const bodyDisposed = body.whenDisposed;
			body[Symbol.dispose]();
			workspace[Symbol.dispose]();
			await Promise.all([workspace.storage.whenDisposed, bodyDisposed]);
		}

		const workspace = model.connect(
			{ kind: 'local' },
			{
				persistence: bunLocalPersistence({ dir }),
			},
		);
		try {
			await workspace.storage.whenLoaded;
			expect(workspace.tables.notes.get('note-1').data?.title).toBe('first');
			const body = workspace.tables.notes.docs.body.open('note-1');
			try {
				await body.whenLoaded;
				expect(body.read()).toBe('durable body');
			} finally {
				body[Symbol.dispose]();
			}
		} finally {
			workspace[Symbol.dispose]();
			await workspace.storage.whenDisposed;
		}
	});

	test('wipe removes the root and child-doc log files', async () => {
		const dir = testDir();
		const workspace = model.connect(
			{ kind: 'local' },
			{
				persistence: bunLocalPersistence({ dir }),
			},
		);
		await workspace.storage.whenLoaded;
		workspace.tables.notes.set({ id: 'note-2', title: 'doomed' });
		const body = workspace.tables.notes.docs.body.open('note-2');
		await body.whenLoaded;
		body.write('gone');
		body[Symbol.dispose]();

		await workspace.wipe();

		const reopened = model.connect(
			{ kind: 'local' },
			{
				persistence: bunLocalPersistence({ dir }),
			},
		);
		try {
			await reopened.storage.whenLoaded;
			expect(reopened.tables.notes.get('note-2').data).toBeNull();
			const reopenedBody = reopened.tables.notes.docs.body.open('note-2');
			try {
				await reopenedBody.whenLoaded;
				expect(reopenedBody.read()).toBe('');
			} finally {
				reopenedBody[Symbol.dispose]();
			}
		} finally {
			reopened[Symbol.dispose]();
			await reopened.storage.whenDisposed;
		}
	});
});
