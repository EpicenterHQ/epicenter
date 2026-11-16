/** Run actions with a lazy container write lock, released when the call ends. */

import {
	type Action,
	encodeActionResult,
	type Folder,
	inRun,
	runYielding,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err } from 'wellcrafted/result';
import { CliError } from './errors.ts';
import { loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
import { type Held, hold, LOCK_WAIT_MS } from './lock.ts';
import { type Answer, type RunAnswer, refused } from './output.ts';
import { setRoutine } from './routine-set.ts';

/**
 * What the action threw, as the answer carries it. A thrown tagged error (a
 * frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
 * makes) is kept whole when it survives JSON. A value that cannot be read
 * or serialized still answers as an action throw, with a safe message.
 */
function threwOf(cause: unknown): {
	message: string;
	thrown?: Record<string, unknown>;
} {
	let message = 'The action threw a value that could not be read';
	try {
		message = extractErrorMessage(cause).slice(0, 4096);
	} catch {
		// Even extracting a message can fail for a cyclic array or a getter.
	}
	try {
		if (typeof cause !== 'object' || cause === null || cause instanceof Error)
			return { message };
		const json = JSON.stringify(cause);
		if (json.length > 4096) return { message };
		const thrown: unknown = JSON.parse(json);
		if (
			typeof thrown === 'object' &&
			thrown !== null &&
			!Array.isArray(thrown) &&
			'name' in thrown &&
			typeof thrown.name === 'string' &&
			'message' in thrown &&
			typeof thrown.message === 'string'
		)
			return { message, thrown };
	} catch {
		// Error details are best effort; they must not prevent the call's answer.
	}
	return { message };
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
		edit: writing(folder.edit),
		update: writing(folder.update),
		delete: writing(folder.delete),
	};
}

/** Run a checked action; its first write owns the container until it ends. */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	{ onYield, signal }: Following = {},
): Promise<RunAnswer> {
	const readOnly = action.annotations?.readOnlyHint === true;
	let owning: Promise<void> | undefined;
	let held: Held | undefined;
	const own = () =>
		(owning ??= (async () => {
			held = await hold(located.realPath, LOCK_WAIT_MS);
			if (!held)
				throw new Error(
					`${located.name} is busy: another write held it for ${LOCK_WAIT_MS / 1000} seconds`,
				);
		})());
	const folder = forCall(located.context.folder, own, readOnly);
	const context = {
		...located.context,
		folder,
		signal,
		routines: {
			set: (
				name: string,
				routine: Parameters<typeof setRoutine>[0]['routine'],
			) => {
				if (readOnly)
					throw new Error(
						`The action "${key}" is read-only, so it cannot set a routine`,
					);
				return setRoutine({ app: located, name, routine });
			},
		},
		...(readOnly ? { readOnly: { action: key } } : {}),
	};
	try {
		const result = await inRun(context, () =>
			runYielding(action, input, async (value) => {
				if (signal?.aborted) throw new Error('The caller stopped the call');
				await onYield?.(value);
			}),
		);
		const encoded = encodeActionResult(result);
		return encoded.error === null
			? encoded
			: Err({ kind: 'returned', reason: encoded.error });
	} catch (cause) {
		return Err({ kind: 'fault', ...threwOf(cause) });
	} finally {
		held?.release();
	}
}

/** Who follows a call as it runs: each value it yields, and when they stop listening. */
export type Following = {
	/**
	 * The call came over MCP, whose input sits in an agent's transcript: a
	 * call with private input is refused before it runs.
	 */
	overMcp?: boolean;
	/** Each value the action yields, in order; the action waits for it. */
	onYield?: (value: unknown) => unknown;
	/** Execution cancellation signal. HTTP observers do not own it. */
	signal?: AbortSignal;
};

/** Load the current code, check input, and run the requested action. */
export async function callAction(
	name: string,
	key: string,
	raw: unknown,
	following: Following = {},
): Promise<Answer> {
	const usage = (message: string, next?: string) =>
		refused(CliError.Usage({ message, next }).error);
	try {
		const { data: located, error: notFound } = await loadHomeApp(name);
		if (notFound) return refused(notFound);
		if (!located.ok)
			return refused(
				CliError.AppProblems({ app: name, problems: located.problems }).error,
			);
		const action = Object.hasOwn(located.actions, key)
			? located.actions[key]
			: undefined;
		if (!action)
			return usage(`${name} has no action "${key}"`, `epicenter ${name}`);
		if (following.overMcp && action.privateInput === true)
			return usage(
				`${name} ${key} takes private input, so it is not offered over MCP. Use ${name}'s own page, or pipe JSON to epicenter ${name} ${key} -`,
				`epicenter ${name} ${key}`,
			);
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
			return usage('The input is not a JSON object');
		const checked = checkInput(action, raw);
		if ('error' in checked)
			return usage(checked.error, `epicenter ${name} ${key} --help`);
		return runAction(located, key, action, checked.input, following);
	} catch (cause) {
		return refused(CliError.Internal({ cause }).error);
	}
}
