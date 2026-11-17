/** Run actions: find one, check its input, and answer what it did. */

import {
	type Action,
	encodeActionResult,
	inRun,
	isActionResult,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err } from 'wellcrafted/result';
import { CliError } from './errors.ts';
import { loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
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

/** Run a checked action. Nothing locks it: one process runs actions (ADR-0936). */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	{ onUpdate }: Following = {},
): Promise<RunAnswer> {
	const context = {
		...located.context,
		routines: {
			set: (
				name: string,
				routine: Parameters<typeof setRoutine>[0]['routine'],
			) => setRoutine({ app: located, name, routine }),
		},
	};
	try {
		const result = await inRun(context, () => action(input, { onUpdate }));
		// An action made without `defineAction` is checked here, where every call passes.
		if (!isActionResult(result))
			throw new TypeError(
				`The action "${key}" must return Ok(data) or Err(error)`,
			);
		const encoded = encodeActionResult(result);
		return encoded.error === null
			? encoded
			: Err({ kind: 'returned', reason: encoded.error });
	} catch (cause) {
		return Err({ kind: 'fault', ...threwOf(cause) });
	}
}

/** Who follows a call as it runs. */
export type Following = {
	/** Each update the action sends, in order. The action never waits for it. */
	onUpdate?: (value: unknown) => unknown;
};

/** A call that is ready to run, or the refusal that answers it instead. */
export type Resolved =
	| { refusal: ReturnType<typeof refused> }
	| {
			refusal?: undefined;
			located: Runnable;
			action: Action;
			input: Record<string, unknown>;
	  };

/**
 * Load the current code, find the action, and check its input, running
 * nothing.
 */
export async function resolveAction(
	name: string,
	key: string,
	raw: unknown,
): Promise<Resolved> {
	const usage = (message: string, next?: string) => ({
		refusal: refused(CliError.Usage({ message, next }).error),
	});
	try {
		const { data: located, error: notFound } = await loadHomeApp(name);
		if (notFound) return { refusal: refused(notFound) };
		if (!located.ok)
			return {
				refusal: refused(
					CliError.AppProblems({ app: name, problems: located.problems }).error,
				),
			};
		const action = Object.hasOwn(located.actions, key)
			? located.actions[key]
			: undefined;
		if (!action)
			return usage(`${name} has no action "${key}"`, `epicenter ${name}`);
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
			return usage('The input is not a JSON object');
		const checked = checkInput(action, raw);
		if ('error' in checked)
			return usage(checked.error, `epicenter ${name} ${key} --help`);
		return { located, action, input: checked.input };
	} catch (cause) {
		return {
			refusal: refused(CliError.Internal({ cause }).error),
		};
	}
}

/** Load the current code, check input, and run the requested action. */
export async function callAction(
	name: string,
	key: string,
	raw: unknown,
	following: Following = {},
): Promise<Answer> {
	const call = await resolveAction(name, key, raw);
	if (call.refusal) return call.refusal;
	return runAction(call.located, key, call.action, call.input, following);
}
