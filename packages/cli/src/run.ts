/**
 * One call, for the command line and both MCP transports (ADR-0850): the
 * action's run and its commit, in the one process that runs the action
 * (`child.ts`). Its first write through `folder` takes the app's lock
 * (`lock.ts`), and the call holds it until it has committed exactly the
 * paths it wrote, under the call's name, so no other write and no snapshot
 * comes between its writes and its commit, from any process. A call that
 * writes nothing takes no lock and commits nothing. A read-only run's writes
 * through `folder` throw, except to a `.local` path, which takes the lock
 * like any write and is never committed.
 * The answer is what the action returned or threw.
 */

import {
	type Action,
	type Folder,
	inRun,
	isLocalPath,
	normalizePath,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Runnable } from './home.ts';
import { type Held, hold, LOCK_WAIT_MS } from './lock.ts';
import type { Answer } from './output.ts';
import { type Snapshot, snapshot } from './snapshot.ts';

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
 * once, through `own`, then is noted in `written`. In a read-only run only a
 * `.local` path takes the lock; `folder` refuses any other path itself, so a
 * refused write never waits on another call.
 */
function forCall(
	folder: Folder,
	own: () => Promise<void>,
	written: Set<string>,
	readOnly: boolean,
): Folder {
	const writing =
		<A extends [string, ...unknown[]], R>(method: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			if (!readOnly || isLocalPath(normalizePath(args[0]))) await own();
			const result = await method(...args);
			written.add(normalizePath(args[0]));
			return result;
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
 * then commit the paths it wrote through `folder` under the call's name,
 * whether it returned or threw (`<call> (threw)`), and let the app's lock go.
 * `committed` is the commit's outcome, absent when the call wrote nothing
 * it could commit.
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
): Promise<{
	answer: Exclude<Answer, { error: unknown }>;
	committed?: Snapshot;
}> {
	const readOnly = action.annotations?.readOnlyHint === true;
	const written = new Set<string>();
	let held: Held | undefined;
	const own = async () => {
		if (held) return;
		held = await hold(located.realPath, LOCK_WAIT_MS);
		if (!held)
			throw new Error(
				`${located.name} is busy: another write held it for ${LOCK_WAIT_MS / 1000} seconds`,
			);
	};
	const folder = forCall(located.context.folder, own, written, readOnly);
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
		if (readOnly || written.size === 0) return { answer };
		const committed = await snapshot(located.name, located.realPath, {
			wrote: {
				call: callName(located.name, key, input[action.positional?.[0] ?? '']),
				paths: [...written].sort(),
				...('threw' in answer ? { threw: true as const } : {}),
			},
		});
		return { answer, committed };
	} finally {
		held?.release();
	}
}
