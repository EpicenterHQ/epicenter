import type { DocumentPatch } from '@epicenter/folder/document';
import { expectOk } from 'wellcrafted/testing';
import type { Backend } from './backend.js';
import { messagesTables } from './definition.js';
import { draftId, type MessagesFolder } from './drafts.js';

export function saveDraft(
	folder: MessagesFolder,
	id: string,
	change: DocumentPatch<typeof messagesTables.drafts>,
) {
	const document = folder.tables.drafts.document(id);
	expectOk(document.patch(change));
	return document.save();
}

/** Deliberate persisted fixtures; selecting a conversation itself creates no file. */
export async function seedDraft(
	folder: MessagesFolder,
	backend: Backend,
	chatId: string,
) {
	const id = await draftId(backend, chatId);
	expectOk(
		await folder.tables.drafts.write(id, {
			fields: {
				chatId,
				mode: backend.mode,
				profile: backend.profile,
				state: 'draft',
				pendingId: '',
			},
			body: '',
		}),
	);
	expectOk(await folder.tables.drafts.document(id).refresh());
	await folder.tables.attempts.document(id).refresh();
	return { id };
}
