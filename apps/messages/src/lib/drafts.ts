/**
 * A reply's way from the composer to Beeper, over this device's drafts and
 * attempts (`contract.ts`): a send records its attempt before Beeper is
 * asked, and an attempt Beeper never confirmed blocks the next send until
 * the person has checked it. Nothing is ever resent on its own.
 */
import type { ClientError } from '@epicenter/definition/contract';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Backend } from './backend.js';
import type { Device } from './context.js';

export const DraftError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});
type DraftError = InferErrors<typeof DraftError>;
type Failure = ClientError | DraftError;

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
const turns = new WeakMap<Device, Map<string, Promise<void>>>();
async function withDraft<T>(
	device: Device,
	id: string,
	action: () => Promise<T>,
) {
	let queue = turns.get(device);
	if (!queue) {
		queue = new Map();
		turns.set(device, queue);
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

/**
 * Whether storage holds the attempt this page shows: another tab may have
 * written one before this page heard of it. Read straight from storage, by
 * version, valid or not.
 */
async function storageAgrees(device: Device, id: string) {
	const listed = await device.client.attempts.list();
	if (listed.error !== null)
		return DraftError.Refused({
			message: 'Could not check storage; try again.',
		});
	const named = (note: { id: string }) => note.id === id;
	const stored =
		listed.data.items.find(named) ?? listed.data.invalid.find(named);
	const shown =
		device.files.attempts.get({ id }) ??
		device.files.attempts.invalid.find(named);
	return stored?.version === shown?.version ? null : changedAttempt();
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
	device: Device,
	{ id, chatId, backend, text, previousAttemptId, unchanged }: SendInput,
): Promise<Result<string, Failure>> {
	return withDraft(device, id, async (): Promise<Result<string, Failure>> => {
		const { files } = device;
		const mismatch = await storageAgrees(device, id);
		if (mismatch) return mismatch;
		const named = (note: { id: string }) => note.id === id;
		const attempt = files.attempts.get({ id });
		if (
			files.attempts.invalid.some(named) ||
			(attempt !== undefined && !matches(attempt, backend, chatId))
		)
			return DraftError.Refused({
				message: 'The send attempt needs Markdown repair before sending again.',
			});
		if (attempt?.state === 'sending') return unresolved();
		if (attempt?.attemptId !== previousAttemptId) return changedAttempt();
		if (files.drafts.invalid.some(named))
			return DraftError.Refused({
				message: 'This draft needs Markdown repair before sending.',
			});
		const draft = files.drafts.get({ id });
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
		const recorded = await (attempt
			? files.attempts.update({ id }, { ...fields, body: text })
			: files.attempts.create({ id, ...fields, body: text }));
		if (recorded.error !== null)
			return DraftError.Refused({
				message: 'Nothing was sent: the attempt could not be saved.',
			});
		if (draft !== undefined && unchanged()) {
			const cleared = await files.drafts.update({ id }, { body: '' });
			if (cleared.error !== null) {
				const acknowledged = await files.attempts.update(
					{ id },
					{ state: 'acknowledged' },
				);
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
		const receipt = await files.attempts.update(
			{ id },
			{ state: 'accepted', pendingId: answer.pendingId },
		);
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
	device: Device,
	{ id, chatId, backend, checkedAttemptId, keep, composerEmpty }: RecoverInput,
): Promise<Result<void, Failure>> {
	return withDraft(device, id, async (): Promise<Result<void, Failure>> => {
		const { files } = device;
		const mismatch = await storageAgrees(device, id);
		if (mismatch) return mismatch;
		const named = (note: { id: string }) => note.id === id;
		const attempt = files.attempts.get({ id });
		if (
			files.attempts.invalid.some(named) ||
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
		const checked = await files.attempts.update(
			{ id },
			{ state: 'acknowledged' },
		);
		if (checked.error !== null) return checked;
		if (!keep || !composerEmpty() || files.drafts.invalid.some(named))
			return Ok(undefined);
		const restored = files.drafts.get({ id })
			? await files.drafts.update({ id }, { body: attempt.body })
			: await files.drafts.create({
					id,
					...fieldsFor(backend, chatId),
					body: attempt.body,
				});
		return restored.error === null ? Ok(undefined) : restored;
	});
}
