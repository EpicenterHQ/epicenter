import { expectOk } from 'wellcrafted/testing';
import type { Backend } from './backend.js';
import { draftId, type MessagesFolder } from './drafts.js';

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
	expectOk(await folder.tables.drafts.edit(id).refresh());
	await folder.tables.attempts.edit(id).refresh();
	return { id };
}
