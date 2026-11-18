/** Run actions: find one, check its input, and answer what it did. */

import {
	type Action,
	ActionError,
	type Answer,
	Err,
	encodeActionResult,
	inRun,
	isActionResult,
	RESERVED_NAMES,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
import { stderrJsonLines } from './output.ts';

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

/** Where serve writes one record for each run, when it ends. */
const runLog = createLogger('cli/run', stderrJsonLines);

/**
 * Run a checked action and answer what it did: its own Result, or `Threw`.
 * An error it returns named `NotStarted` or `Unreachable`, with or without
 * the platform's namespace, answers `Threw`: only Epicenter says a call never
 * began or that its outcome is unknown, and an action can copy the namespace
 * (ADR-0953). Nothing locks it: one process runs actions (ADR-0936).
 * When it ends, `log` gets one record: the app, the action, the outcome and
 * how long it took, and for a failure the error's name. The
 * record has neither the input nor the result, which can hold personal data.
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	{ onUpdate, log = runLog }: Following = {},
): Promise<Answer> {
	const started = performance.now();
	const answer = await settle(key, action, input, located, onUpdate);
	try {
		log.info('action run ended', {
			app: located.name,
			action: key,
			durationMs: Math.round(performance.now() - started),
			...outcomeOf(answer),
		});
	} catch {
		// The record is for the owner; it must not change the caller's answer.
	}
	return answer;
}

/**
 * How a run ended, as its record states it: for a failure, the error's name
 * as the answer carries it, and for `Threw` the thrown value's name when it
 * has one. A message can quote what the person typed, so it stays out.
 */
function outcomeOf({ error }: Answer) {
	if (error === null) return { outcome: 'ok' as const };
	const thrown = (error as { thrown?: { name?: unknown } }).thrown?.name;
	return {
		outcome: 'error' as const,
		error: error.name,
		...(typeof thrown === 'string' && { thrown }),
	};
}

/** Run the action and answer what it did, whether it returned or threw. */
async function settle(
	key: string,
	action: Action,
	input: Record<string, unknown>,
	located: Runnable,
	onUpdate: Following['onUpdate'],
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
	/** Where the record of the run's end goes: stderr, as JSON lines, unless a test passes its own. */
	log?: Logger;
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
		refusal: ActionError.NotStarted({ cause: 'usage', message, next }),
	});
	try {
		const { data: located, error: notLoaded } = await loadHomeApp(name);
		if (notLoaded) return { refusal: Err(notLoaded) };
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
			refusal: ActionError.NotStarted({
				cause: 'internal',
				message: extractErrorMessage(cause),
			}),
		};
	}
}
