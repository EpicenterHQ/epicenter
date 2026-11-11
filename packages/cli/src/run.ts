/**
 * One call runs in its child process and owns its data commit (ADR-0880).
 * Its first folder write takes the app's lock and snapshots pending data as
 * changed outside epicenter. When the action ends, it commits everything
 * pending in data under the call's name, even when it threw. An opening
 * snapshot failure leaves everything pending. A call with no folder write
 * takes no lock and commits nothing. Read-only calls take no lock, including
 * their .local writes. Commit outcomes never change the action's answer.
 */

import { type Action, type Folder, inRun } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import type { CodeState } from './data.ts';
import type { Runnable } from './home.ts';
import { type Held, hold, LOCK_WAIT_MS } from './lock.ts';
import type { Answer } from './output.ts';
import { commitCall, type Snapshot, snapshotData } from './snapshot.ts';

/**
 * What the action threw, as the answer carries it. A thrown tagged error (a
 * frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
 * makes) is kept whole so its name and fields reach the caller.
 */
function threwOf(cause: unknown): {
	message: string;
	thrown?: Record<string, unknown>;
} {
	const message = extractErrorMessage(cause);
	if (typeof cause !== 'object' || cause === null || cause instanceof Error)
		return { message };
	const { name } = cause as { name?: unknown };
	if (
		typeof name !== 'string' ||
		typeof (cause as { message?: unknown }).message !== 'string'
	)
		return { message };
	return { message, thrown: JSON.parse(JSON.stringify(cause)) };
}

/**
 * A call's name in history: the app, the action's words, and its first
 * positional value on one line, cut at 60 characters
 * (`tasks: add Water the plants`).
 */
function callName(app: string, key: string, value: unknown) {
	const suffix =
		value === undefined
			? ''
			: ` ${typeof value === 'string' ? value : JSON.stringify(value)}`;
	return `${app}: ${key}${suffix.replace(/\s+/g, ' ').slice(0, 61)}`;
}

/**
 * `folder` for one call: each write or delete first takes the app's lock,
 * once, through `own`. A read-only run takes no lock; `folder` refuses
 * any non-local write itself.
 */
function forCall(
	folder: Folder,
	own: () => Promise<void>,
	readOnly: boolean,
): Folder {
	const writing =
		<A extends [string, ...unknown[]], R>(method: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			if (!readOnly) await own();
			return method(...args);
		};
	return {
		...folder,
		write: writing(folder.write),
		writeBytes: writing(folder.writeBytes),
		update: writing(folder.update),
		delete: writing(folder.delete),
	};
}

/**
 * Run `action`, the app's `key`, with its checked input in the app's folder,
 * then commit everything pending in data under the call's name,
 * whether it returned or threw (`<call> (threw)`), and let the app's lock go.
 * `committed` is the commit's outcome, absent when the call wrote nothing
 * through `folder`.
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	code: CodeState,
): Promise<{
	answer: Exclude<Answer, { error: unknown }>;
	committed?: Snapshot;
}> {
	const readOnly = action.annotations?.readOnlyHint === true;
	let opening: Snapshot | undefined;
	let owning: Promise<void> | undefined;
	let held: Held | undefined;
	const own = () =>
		(owning ??= (async () => {
			held = await hold(located.realPath, LOCK_WAIT_MS);
			if (!held)
				throw new Error(
					`${located.name} is busy: another write held it for ${LOCK_WAIT_MS / 1000} seconds`,
				);
			opening = await snapshotData(located.name, located.realPath);
		})());
	const folder = forCall(located.context.folder, own, readOnly);
	const context = readOnly
		? { ...located.context, folder, readOnly: { action: key } }
		: { ...located.context, folder };
	let answer: Exclude<Answer, { error: unknown }>;
	try {
		answer = { returned: (await inRun(context, () => action(input))) ?? null };
	} catch (error) {
		answer = { threw: threwOf(error) };
	}
	try {
		if (!held) return { answer };
		if (opening && 'failed' in opening) return { answer, committed: opening };
		const committed = await commitCall(located.name, located.realPath, {
			subject:
				callName(located.name, key, input[action.positional?.[0] ?? '']) +
				('threw' in answer ? ' (threw)' : ''),
			code,
		});
		return { answer, committed };
	} finally {
		held?.release();
	}
}
