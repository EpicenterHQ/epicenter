/**
 * A reply's way from the composer to Beeper, over the folder's drafts and
 * attempts (`contract.ts`): a send records its attempt before Beeper is
 * asked, and an attempt Beeper never confirmed blocks the next send until
 * the person has checked it. Nothing is ever resent on its own.
 *
 * A write never fails (ADR-0775): it answers once it has landed, and while
 * storage cannot be reached it waits. So a send waits for its attempt, and
 * for the draft's clear, to land before Beeper is asked; what can refuse a
 * send is only what the folder shows.
 *
 * Each workflow takes the folder it works over: the page's own
 * (`folder` from `app.ts`), as the page shows it.
 */
import type { Folder } from '@epicenter/folder/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Backend } from './backend.js';
import type { Messages } from './contract.js';

export const DraftError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});
type DraftError = InferErrors<typeof DraftError>;

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

/**
 * Only send and recovery workflows write attempts: one at a time per draft,
 * across this browser's tabs and within each, in the order asked
 * (`navigator.locks` queues both).
 */
function withDraft<T>(id: string, action: () => Promise<T>): Promise<T> {
	return navigator.locks.request(`messages-send-${id}`, action) as Promise<T>;
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

/**
 * Show the attempts as storage holds them now: another tab may have written
 * one before this page heard of it (`list()` lists and reads the attempts
 * again, and shows what it read). The checks after it then compare the attempt the person saw, by
 * its `attemptId`, with the one stored.
 */
async function readAttempts(folder: Folder<Messages>) {
	const listed = await folder.attempts.list();
	if (listed.error === null) return null;
	return DraftError.Refused({
		message: 'Could not check storage; try again.',
	});
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
	folder: Folder<Messages>,
	{ id, chatId, backend, text, previousAttemptId, unchanged }: SendInput,
): Promise<Result<string, DraftError>> {
	return withDraft(
		id,
		async (): Promise<Result<string, DraftError>> => {
			const unread = await readAttempts(folder);
			if (unread) return unread;
			const named = (note: { id: string }) => note.id === id;
			const attempt = folder.attempts.get({ id });
			if (
				folder.attempts.invalid().some(named) ||
				(attempt !== undefined && !matches(attempt, backend, chatId))
			)
				return DraftError.Refused({
					message:
						'The send attempt needs Markdown repair before sending again.',
				});
			if (attempt?.state === 'sending') return unresolved();
			if (attempt?.attemptId !== previousAttemptId) return changedAttempt();
			if (folder.drafts.invalid().some(named))
				return DraftError.Refused({
					message: 'This draft needs Markdown repair before sending.',
				});
			const draft = folder.drafts.get({ id });
			if (draft !== undefined && !matches(draft, backend, chatId))
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
			await folder.attempts.set({ id }, { ...fields, body: text });
			if (draft !== undefined && unchanged())
				await folder.drafts.set({ id }, { body: '' });
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
			await folder.attempts.set(
				{ id },
				{ state: 'accepted', pendingId: answer.pendingId },
			);
			return Ok(answer.pendingId);
		},
	);
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
	folder: Folder<Messages>,
	{ id, chatId, backend, checkedAttemptId, keep, composerEmpty }: RecoverInput,
): Promise<Result<void, DraftError>> {
	return withDraft(id, async (): Promise<Result<void, DraftError>> => {
		const unread = await readAttempts(folder);
		if (unread) return unread;
		const named = (note: { id: string }) => note.id === id;
		const attempt = folder.attempts.get({ id });
		if (
			folder.attempts.invalid().some(named) ||
			(attempt !== undefined && !matches(attempt, backend, chatId))
		)
			return DraftError.Refused({
				message: 'The send attempt needs Markdown repair before checking it.',
			});
		if (attempt?.state !== 'sending') return Ok(undefined);
		if (attempt.attemptId !== checkedAttemptId)
			return DraftError.Refused({
				message:
					'The send attempt changed. Check the latest attempt before continuing.',
			});
		await folder.attempts.set({ id }, { state: 'acknowledged' });
		if (!keep || !composerEmpty() || folder.drafts.invalid().some(named))
			return Ok(undefined);
		await folder.drafts.set(
			{ id },
			{ ...fieldsFor(backend, chatId), body: attempt.body },
		);
		return Ok(undefined);
	});
}
