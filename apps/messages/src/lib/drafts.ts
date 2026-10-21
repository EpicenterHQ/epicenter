import type { Folder, ReadError, Row, SaveError } from '@epicenter/folder';
import { documentChange } from '@epicenter/folder/documents';
import type { ActionError } from '@epicenter/folder/edits';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Backend } from './backend.js';
import type { messagesTables } from './definition.js';

export const DraftError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});

export type MessagesFolder = Folder<typeof messagesTables>;

export async function draftId(
	backend: Pick<Backend, 'mode' | 'profile'>,
	chatId: string,
) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			JSON.stringify([backend.mode, backend.profile, chatId]),
		),
	);
	return `${backend.mode}-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** An empty composer is initialized once; future reads preserve every existing byte. */
export async function openDraft(
	folder: MessagesFolder,
	backend: Backend,
	chatId: string,
): Promise<
	Result<
		{ id: string; row: Row<(typeof messagesTables)['drafts']> },
		ReadError | SaveError | ActionError
	>
> {
	const opened = await folder.run([], async (work) => {
		const id = await draftId(backend, chatId);
		const read = await work.tables.drafts.get(id);
		if (read.error !== null) return read;
		if (read.data !== undefined) return Ok({ id, row: read.data });
		const saved = await work.tables.drafts.set(id, null, {
			fields: {
				chatId,
				profile: backend.profile,
				mode: backend.mode,
				state: 'draft',
				pendingId: '',
			},
			body: '',
		});
		if (saved.error !== null) return saved;
		return Ok({ id, row: saved.data.sent });
	});
	if (opened.error !== null) return opened;
	return opened.data;
}

/** Save a durable fence before contacting Beeper; never replay a send after a crash. */
export async function sendDraft(
	folder: MessagesFolder,
	chatId: string,
	backend: Backend,
): Promise<
	Result<
		string,
		ReadError | SaveError | ActionError | InferErrors<typeof DraftError>
	>
> {
	const admitted = await folder.run([], async (lifetime) => {
		const id = await draftId(backend, chatId);
		const path = `drafts/${id}.md`;
		const send = () =>
			lifetime.run([path], async (work) => {
				const read = await work.tables.drafts.get(id);
				if (read.error !== null) return read;
				const row = read.data;
				if (!row || row.issues !== null)
					return DraftError.Refused({
						message:
							'The draft could not be read. Open its Markdown file to repair it.',
					});
				if (row.fields.state === 'sending')
					return DraftError.Refused({
						message: 'Check this attempt in Beeper before sending again.',
					});
				if (
					row.fields.chatId !== chatId ||
					row.fields.mode !== backend.mode ||
					row.fields.profile !== backend.profile
				)
					return DraftError.Refused({
						message:
							'This draft does not match the conversation or connection. Check its Markdown file.',
					});
				if (!row.body.trim())
					return DraftError.Refused({ message: 'Write a message first.' });
				if (row.body.length > 20000)
					return DraftError.Refused({
						message: 'Messages must be at most 20,000 characters.',
					});
				const prepared = documentChange(row, {
					fields: { state: 'sending', pendingId: '' },
				});
				if (prepared.error !== null)
					return DraftError.Refused({ message: prepared.error.reason });
				const text = prepared.data.text;
				const fenced = await work.files.write(path, row.text, text);
				if (fenced.error !== null) return fenced;
				const answer = await backend.request({
					action: 'send',
					chatId,
					profile: backend.profile,
					text: row.body,
				});
				if (answer.kind !== 'accepted')
					return DraftError.Refused({
						message:
							answer.kind === 'error'
								? answer.message
								: 'Beeper did not confirm the send. Check Beeper before trying again.',
					});
				const receipt = documentChange(
					{ text, issues: null },
					{
						fields: { state: 'accepted', pendingId: answer.pendingId },
						body: '',
					},
				);
				if (receipt.error !== null)
					return DraftError.Refused({
						message:
							'Beeper accepted the message, but its receipt could not be prepared. Check Beeper before sending again.',
					});
				const accepted = await work.files.write(path, text, receipt.data.text);
				if (accepted.error !== null)
					return DraftError.Refused({
						message:
							'Beeper accepted the message, but the receipt could not be saved. Check Beeper before sending again.',
					});
				return Ok(answer.pendingId);
			});
		// The desktop host reuses one window per folder. Web Locks also serialize browser tabs.
		const fenced =
			typeof navigator !== 'undefined' && navigator.locks
				? await navigator.locks.request(`messages-send-${id}`, send)
				: await send();
		if (fenced.error !== null) return Err(fenced.error);
		return fenced.data;
	});
	if (admitted.error !== null) return admitted;
	return admitted.data;
}
