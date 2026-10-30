import type { Patch } from '@epicenter/folder';
import { expectOk } from 'wellcrafted/testing';
import type { Backend } from './backend.js';
import { messagesTables } from './definition.js';
import { draftId, type MessagesFolder } from './drafts.js';

export function saveDraft(
	folder: MessagesFolder,
	id: string,
	change: Patch<typeof messagesTables.drafts>,
) {
	return folder.tables.drafts.update(id, change);
}

/** Deliberate persisted fixtures; selecting a conversation itself creates no file. */
export async function seedDraft(
	folder: MessagesFolder,
	backend: Backend,
	chatId: string,
) {
	const id = await draftId(backend, chatId);
	expectOk(
		await folder.tables.drafts.create(id, {
			fields: {
				chatId,
				mode: backend.mode,
				profile: backend.profile,
			},
			body: '',
		}),
	);
	return { id };
}
