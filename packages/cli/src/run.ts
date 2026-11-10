/**
 * One action's run, for the command line and both MCP transports (ADR-0850).
 * The action writes through its folder as it runs, and the run commits
 * nothing: whoever started it commits afterwards (`snapshot.ts`). A run that
 * is not read-only reports the call, the paths it wrote through `folder`, and
 * whether it threw, so the parent commits exactly those paths under the
 * call's name. A read-only run's writes through `folder` and `secrets` throw.
 * The answer is what the action returned or threw.
 */

import { type Action, type Folder, inRun, normalizePath } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Runnable } from './home.ts';
import type { Answer } from './output.ts';
import type { Wrote } from './snapshot.ts';

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

/** `folder`, noting in `written` each path it writes or deletes. */
function noting(folder: Folder, written: Set<string>): Folder {
	const note =
		<A extends [string, ...unknown[]], R>(method: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			const result = await method(...args);
			written.add(normalizePath(args[0]));
			return result;
		};
	return {
		...folder,
		write: note(folder.write),
		writeBytes: note(folder.writeBytes),
		update: note(folder.update),
		delete: note(folder.delete),
	};
}

/**
 * Run `action`, the app's `key`, with its checked input in the app's folder.
 * When it is not read-only, the paths it wrote through `folder` are reported
 * under the call's name, whether it returned or threw.
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
): Promise<{ answer: Exclude<Answer, { error: unknown }>; wrote?: Wrote }> {
	const readOnly = action.annotations?.readOnlyHint === true;
	const written = new Set<string>();
	const context = readOnly
		? { ...located.context, readOnly: { action: key } }
		: {
				...located.context,
				folder: noting(located.context.folder, written),
			};
	let answer: Exclude<Answer, { error: unknown }>;
	try {
		answer = { returned: (await inRun(context, () => action(input))) ?? null };
	} catch (error) {
		answer = { threw: threwOf(error) };
	}
	if (readOnly) return { answer };
	return {
		answer,
		wrote: {
			call: callName(located.name, key, input[action.positional?.[0] ?? '']),
			paths: [...written].sort(),
			...('threw' in answer ? { threw: true as const } : {}),
		},
	};
}
