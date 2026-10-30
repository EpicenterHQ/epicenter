import type { WriteError } from '@epicenter/folder';
import type { SvelteFolder } from '@epicenter/svelte/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Backend } from './backend.js';
import type { messagesTables } from './definition.js';

export const DraftError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});
type DraftError = InferErrors<typeof DraftError>;
export type MessagesFolder = SvelteFolder<typeof messagesTables>;
type Failure = WriteError | DraftError;

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

/** Only send and recovery workflows write attempts. */
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
const changedAttempt = () =>
	DraftError.Refused({
		message:
			'Another send was recorded. Review the latest attempt before sending again.',
	});
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

/** A second tab may have written an attempt before its hint reached this mirror. */
async function storageAgrees(folder: MessagesFolder, path: string) {
	const fresh = await folder.read(path);
	if (fresh.error !== null) {
		void folder.refresh();
		return DraftError.Refused({
			message: 'Could not check storage; try again.',
		});
	}
	let text: string | undefined;
	try {
		text =
			fresh.data === null
				? undefined
				: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
						fresh.data,
					);
	} catch {
		void folder.refresh();
		return changedAttempt();
	}
	if (text !== folder.file(path)?.data) {
		void folder.refresh();
		return changedAttempt();
	}
	return null;
}

type SendInput = {
	id: string;
	chatId: string;
	backend: Backend;
	text: string;
	previousAttemptId: string | undefined;
	unchanged: () => boolean;
};

/** Persist an isolated attempt before contacting Beeper. An uncertain attempt is never replayed automatically. */
export async function sendDraft(
	folder: MessagesFolder,
	{ id, chatId, backend, text, previousAttemptId, unchanged }: SendInput,
): Promise<Result<string, Failure>> {
	return withDraft(folder, id, async (): Promise<Result<string, Failure>> => {
		const path = `attempts/${id}.md`;
		const mismatch = await storageAgrees(folder, path);
		if (mismatch) return mismatch;
		const attempt = folder.tables.attempts.row(id);
		if (attempt !== undefined) {
			if (attempt.issues !== null || !matches(attempt.fields, backend, chatId))
				return DraftError.Refused({
					message:
						'The send attempt needs Markdown repair before sending again.',
				});
			if (attempt.fields.state === 'sending') return unresolved();
		}
		if (attempt?.fields?.attemptId !== previousAttemptId)
			return changedAttempt();
		const draft = folder.tables.drafts.row(id);
		if (draft !== undefined && draft.issues !== null)
			return DraftError.Refused({
				message: 'This draft needs Markdown repair before sending.',
			});
		if (
			draft !== undefined &&
			draft.issues === null &&
			!matches(draft.fields, backend, chatId)
		)
			return DraftError.Refused({
				message:
					'This draft does not match the conversation or connection. Check its Markdown file.',
			});
		if (!text.trim())
			return DraftError.Refused({ message: 'Write a message first.' });
		if (text.length > 20_000)
			return DraftError.Refused({
				message: 'Messages must be at most 20,000 characters.',
			});
		const fields = {
			...fieldsFor(backend, chatId),
			state: 'sending' as const,
			attemptId: crypto.randomUUID(),
			pendingId: '',
		};
		const recorded = await (attempt
			? folder.tables.attempts.update(id, { fields, body: text })
			: folder.tables.attempts.create(id, { fields, body: text }));
		if (recorded.error !== null)
			return DraftError.Refused({
				message: 'Nothing was sent: the attempt could not be saved.',
			});
		if (unchanged()) {
			const cleared = await folder.tables.drafts.update(id, { body: '' });
			if (cleared.error !== null) {
				const acknowledged = await folder.tables.attempts.update(id, {
					fields: { state: 'acknowledged' },
				});
				return DraftError.Refused({
					message:
						acknowledged.error === null
							? 'Nothing was sent. The draft is still saved and can be sent again.'
							: 'Nothing was sent. The attempt could not be acknowledged; check the recorded attempt before sending again.',
				});
			}
		}
		const answer = await backend.request({
			action: 'send',
			chatId,
			profile: backend.profile,
			text,
		});
		if (answer.kind !== 'accepted')
			return DraftError.Refused({
				message:
					answer.kind === 'error'
						? answer.message
						: 'Beeper did not confirm the send. Check Beeper before trying again.',
			});
		const receipt = await folder.tables.attempts.update(id, {
			fields: { state: 'accepted', pendingId: answer.pendingId },
		});
		if (receipt.error !== null)
			return DraftError.Refused({
				message:
					'Beeper accepted the message, but its receipt could not be saved. Check Beeper before sending again.',
			});
		return Ok(answer.pendingId);
	});
}

type RecoverInput = {
	id: string;
	chatId: string;
	backend: Backend;
	checkedAttemptId: string;
	keep: boolean;
	composerEmpty: () => boolean;
};

/** A checked outcome is serialized with sends and bound to the displayed attempt ID. */
export async function recoverDraft(
	folder: MessagesFolder,
	{ id, chatId, backend, checkedAttemptId, keep, composerEmpty }: RecoverInput,
): Promise<Result<void, Failure>> {
	return withDraft(folder, id, async (): Promise<Result<void, Failure>> => {
		const mismatch = await storageAgrees(folder, `attempts/${id}.md`);
		if (mismatch) return mismatch;
		const attempt = folder.tables.attempts.row(id);
		if (attempt === undefined) return Ok(undefined);
		if (attempt.issues !== null || !matches(attempt.fields, backend, chatId))
			return DraftError.Refused({
				message: 'The send attempt needs Markdown repair before checking it.',
			});
		if (attempt.fields.state !== 'sending') return Ok(undefined);
		if (attempt.fields.attemptId !== checkedAttemptId)
			return DraftError.Refused({
				message:
					'The send attempt changed. Check the latest attempt before continuing.',
			});
		const checked = await folder.tables.attempts.update(id, {
			fields: { state: 'acknowledged' },
		});
		if (checked.error !== null) return checked;
		if (!keep || !composerEmpty()) return Ok(undefined);
		const draft = folder.tables.drafts.row(id);
		if (draft !== undefined && draft.issues !== null) return Ok(undefined);
		return draft
			? folder.tables.drafts.update(id, { body: attempt.body })
			: folder.tables.drafts.create(id, {
					fields: fieldsFor(backend, chatId),
					body: attempt.body,
				});
	});
}
