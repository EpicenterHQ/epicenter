import type { Folder, ReadError, SaveError } from '@epicenter/folder';
import { documentChange } from '@epicenter/folder/documents';
import type { ActionError, ChangeError } from '@epicenter/folder/edits';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Backend } from './backend.js';
import type { messagesTables } from './definition.js';

export const DraftError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});
type DraftError = InferErrors<typeof DraftError>;
export type MessagesFolder = Folder<typeof messagesTables>;
type Failure = ReadError | SaveError | ActionError | DraftError;

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

const fieldsFor = (backend: Backend, chatId: string) => ({
	chatId,
	profile: backend.profile,
	mode: backend.mode,
});

/** First input creates a draft; observing an empty composer creates no file. */
export function changeDraft(
	folder: MessagesFolder,
	id: string,
	chatId: string,
	backend: Backend,
	body: string,
): Result<void, ChangeError | DraftError> {
	const edit = folder.tables.drafts.edit(id);
	const snapshot = edit.getSnapshot();
	if (snapshot.content !== undefined) {
		const attempt = folder.tables.attempts.edit(id).getSnapshot().content;
		if (snapshot.content.fields?.state === 'sending' && attempt === undefined)
			return unresolved();
		return edit.change({ body });
	}
	if (snapshot.loadError?.name !== 'Missing')
		return DraftError.Refused({
			message: 'Wait for this draft to open before typing.',
		});
	const created = documentChange(
		{ text: '', issues: null },
		{
			fields: { ...fieldsFor(backend, chatId), state: 'draft', pendingId: '' },
			body,
		},
	);
	if (created.error !== null)
		return DraftError.Refused({ message: created.error.reason });
	return edit.replaceText(created.data.text);
}

/** Only send/recovery workflows write attempts; composer autosave has no authority over them. */
const turns = new WeakMap<MessagesFolder, Map<string, Promise<void>>>();
async function withDraft<T>(
	folder: MessagesFolder,
	id: string,
	action: () => Promise<T>,
) {
	let queue = turns.get(folder);
	if (!queue) {
		queue = new Map();
		turns.set(folder, queue);
	}
	const previous = queue.get(id) ?? Promise.resolve();
	const turn = Promise.withResolvers<void>();
	queue.set(id, turn.promise);
	await previous.catch(() => {});
	try {
		return typeof navigator !== 'undefined' && navigator.locks
			? await navigator.locks.request(`messages-send-${id}`, action)
			: await action();
	} finally {
		turn.resolve();
		if (queue.get(id) === turn.promise) queue.delete(id);
	}
}

const unresolved = () =>
	DraftError.Refused({
		message: 'Check this attempt in Beeper before sending again.',
	});
function attemptText(
	backend: Backend,
	chatId: string,
	body: string,
	state: 'sending' | 'accepted' | 'acknowledged',
	attemptId: string,
	pendingId = '',
) {
	return documentChange(
		{ text: '', issues: null },
		{
			fields: { ...fieldsFor(backend, chatId), state, attemptId, pendingId },
			body,
		},
	);
}
function matches(
	fields: { chatId: string; profile: string; mode: string },
	backend: Backend,
	chatId: string,
) {
	return (
		fields.chatId === chatId &&
		fields.profile === backend.profile &&
		fields.mode === backend.mode
	);
}

/** Persist an isolated attempt before contacting Beeper. An uncertain attempt is never replayed automatically. */
export async function sendDraft(
	folder: MessagesFolder,
	id: string,
	chatId: string,
	backend: Backend,
): Promise<Result<string, Failure>> {
	const sent = await folder.run(async (): Promise<Result<string, Failure>> => {
		const edit = folder.tables.drafts.edit(id);
		const offered = edit.getSnapshot().content;
		if (offered === undefined || offered.issues !== null)
			return DraftError.Refused({
				message: 'Wait for this draft to open, or repair it as Markdown.',
			});
		const knownAttempt = folder.tables.attempts.edit(id).getSnapshot();
		const previousId =
			knownAttempt.loadError?.name === 'Missing'
				? undefined
				: knownAttempt.content?.fields?.attemptId;
		let changed = false;
		const stop = edit.subscribe((snapshot) => {
			if (
				snapshot.content !== undefined &&
				snapshot.content.text !== offered.text
			)
				changed = true;
		});
		try {
			return await withDraft(
				folder,
				id,
				async (): Promise<Result<string, Failure>> => {
					// Decisions use persisted attempts, never a stale editor snapshot.
					const attempt = await folder.tables.attempts.get(id);
					if (attempt.error !== null) return attempt;
					if (
						attempt.data !== undefined &&
						(attempt.data.issues !== null ||
							!matches(attempt.data.fields, backend, chatId))
					)
						return DraftError.Refused({
							message:
								'The send attempt could not be read. Repair its Markdown before sending again.',
						});
					if (attempt.data?.fields?.state === 'sending') return unresolved();
					if (attempt.data?.fields?.attemptId !== previousId)
						return DraftError.Refused({
							message:
								'Another send was recorded. Review the latest attempt before sending again.',
						});
					const read = await folder.tables.drafts.get(id);
					if (read.error !== null) return read;
					// Existing sending records are real recovery data, even if a held composition differs.
					if (
						attempt.data === undefined &&
						read.data?.fields?.state === 'sending'
					)
						return unresolved();
					const row = offered;
					if (!matches(row.fields, backend, chatId))
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
					const attemptId = crypto.randomUUID();
					const prepared = attemptText(
						backend,
						chatId,
						row.body,
						'sending',
						attemptId,
					);
					if (prepared.error !== null)
						return DraftError.Refused({ message: prepared.error.reason });
					// Observe the entire admitted transfer, including time waiting for another send.
					const saved = await folder.files.write(
						`attempts/${id}.md`,
						prepared.data.text,
					);
					if (saved.error !== null) return saved;
					if (!changed && edit.getSnapshot().content?.text === row.text) {
						const cleared = await folder.tables.drafts.set(id, {
							body: '',
							fields: { state: 'draft', pendingId: '' },
						});
						if (cleared.error !== null)
							return DraftError.Refused({
								message: `Nothing was sent. Preparing the draft failed: ${cleared.error.message}`,
							});
					}
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
					const receipt = attemptText(
						backend,
						chatId,
						row.body,
						'accepted',
						attemptId,
						answer.pendingId,
					);
					if (receipt.error !== null)
						return DraftError.Refused({
							message:
								'Beeper accepted the message, but its receipt could not be prepared. Check Beeper before sending again.',
						});
					const recorded = await folder.files.write(
						`attempts/${id}.md`,
						receipt.data.text,
					);
					if (recorded.error !== null)
						return DraftError.Refused({
							message:
								'Beeper accepted the message, but its receipt could not be saved. Check Beeper before sending again.',
						});
					return Ok(answer.pendingId);
				},
			);
		} finally {
			stop();
		}
	});
	return sent.error !== null ? sent : sent.data;
}

/** The particular attempt the person checked, including existing unresolved draft records. */
export type CheckedAttempt = { attemptId: string } | { legacyText: string };

/** An explicit checked outcome, serialized with sends and based on a fresh persisted attempt. */
export async function recoverDraft(
	folder: MessagesFolder,
	id: string,
	chatId: string,
	backend: Backend,
	checkedAttempt: CheckedAttempt,
	keep: boolean,
): Promise<Result<void, Failure>> {
	const recovered = await folder.run(() =>
		withDraft(folder, id, async (): Promise<Result<void, Failure>> => {
			const read = await folder.tables.attempts.get(id);
			if (read.error !== null) return read;
			const draft = await folder.tables.drafts.get(id);
			if (draft.error !== null) return draft;
			const legacy =
				read.data === undefined &&
				draft.data?.issues === null &&
				draft.data.fields.state === 'sending'
					? draft.data
					: undefined;
			const attempt = read.data ?? legacy;
			if (attempt === undefined) return Ok(undefined);
			if (attempt.issues !== null || !matches(attempt.fields, backend, chatId))
				return DraftError.Refused({
					message:
						'The send attempt could not be read. Check its Markdown file.',
				});
			// A recovery clicked on a remounted stale UI cannot reset an attempt that has since succeeded.
			if (attempt.fields.state !== 'sending') return Ok(undefined);
			if (
				read.data !== undefined
					? !('attemptId' in checkedAttempt) ||
						read.data.fields?.attemptId !== checkedAttempt.attemptId
					: !('legacyText' in checkedAttempt) ||
						legacy?.text !== checkedAttempt.legacyText
			)
				return DraftError.Refused({
					message:
						'The send attempt changed. Check the latest attempt before continuing.',
				});
			const attemptId =
				'attemptId' in checkedAttempt
					? checkedAttempt.attemptId
					: crypto.randomUUID();
			const checked = attemptText(
				backend,
				chatId,
				attempt.body,
				'acknowledged',
				attemptId,
				attempt.fields.pendingId,
			);
			if (checked.error !== null)
				return DraftError.Refused({ message: checked.error.reason });
			const edit = folder.tables.drafts.edit(id);
			const current = edit.getSnapshot().content ?? draft.data;
			let changed = false;
			const stop = edit.subscribe((snapshot) => {
				if (
					snapshot.content !== undefined &&
					snapshot.content.text !== current?.text
				)
					changed = true;
			});
			try {
				const saved = await folder.files.write(
					`attempts/${id}.md`,
					checked.data.text,
				);
				if (saved.error !== null) return saved;
				if (changed || (current !== undefined && current.issues !== null))
					return Ok(undefined);
				const body =
					keep && (!current || current.body === '')
						? attempt.body
						: !keep &&
								legacy !== undefined &&
								current?.fields.state === 'sending' &&
								current.body === legacy.body
							? ''
							: (current?.body ?? '');
				const restored = await folder.tables.drafts.set(id, {
					fields: {
						...fieldsFor(backend, chatId),
						state: 'draft',
						pendingId: '',
					},
					body,
				});
				return restored.error !== null ? restored : Ok(undefined);
			} finally {
				stop();
			}
		}),
	);
	return recovered.error !== null ? recovered : recovered.data;
}
