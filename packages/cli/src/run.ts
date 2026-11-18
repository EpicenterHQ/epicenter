/** Run actions: find one, check its input, and answer what it did. */

import {
	type Action,
	ActionError,
	type Answer,
	encodeActionResult,
	inRun,
	isActionResult,
	RESERVED_NAMES,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { CliError } from './errors.ts';
import { loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
import { notStarted } from './output.ts';

type Thrown = { name: string; message: string } & Record<string, unknown>;

/**
 * What the action threw, as `Threw` carries it. A thrown tagged error (a
 * frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
 * makes) is kept whole when it survives JSON. A value that cannot be read
 * or serialized still answers as an action throw, with a safe message.
 */
function threwOf(cause: unknown): {
	message: string;
	thrown?: Thrown;
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
			return { message, thrown: thrown as Thrown };
	} catch {
		// Error details are best effort; they must not prevent the call's answer.
	}
	return { message };
}

/**
 * Run a checked action and answer what it did: its own Result, or `Threw`.
 * An error it returns named `NotStarted` or `Unreachable`, with or without
 * the platform's namespace, answers `Threw`: only Epicenter says a call never
 * began or that its outcome is unknown, and an action can copy the namespace
 * (ADR-0953). Nothing locks it: one process runs actions (ADR-0936).
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	{ onUpdate }: Following = {},
): Promise<Answer> {
	const context = {
		...located.context,
	};
	try {
		const result = await inRun(context, () => action(input, { onUpdate }));
		// An action made without `defineAction` is checked here, where every call passes.
		if (!isActionResult(result))
			throw new TypeError(
				`The action "${key}" must return Ok(data) or Err(error)`,
			);
		const encoded = encodeActionResult(result);
		if (encoded.error && RESERVED_NAMES.includes(encoded.error.name))
			return ActionError.Threw({
				message: `The action "${key}" returned ${encoded.error.name}, a name only Epicenter answers`,
			});
		return encoded;
	} catch (cause) {
		return ActionError.Threw(threwOf(cause));
	}
}

/** Who follows a call as it runs. */
export type Following = {
	/** Each update the action sends, in order. The action never waits for it. */
	onUpdate?: (value: unknown) => unknown;
};

/** A call that is ready to run, or the `NotStarted` that answers it instead. */
export type Resolved =
	| { refusal: Answer }
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
		refusal: notStarted(CliError.Usage({ message, next }).error),
	});
	try {
		const { data: located, error: notFound } = await loadHomeApp(name);
		if (notFound) return { refusal: notStarted(notFound) };
		if (!located.ok)
			return {
				refusal: notStarted(
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
			refusal: notStarted(CliError.Internal({ cause }).error),
		};
	}
}
