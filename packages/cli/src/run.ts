/** Run actions: find one, check its input, and answer what it did. */

import {
	type Action,
	encodeActionResult,
	inRun,
	isActionResult,
} from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err } from 'wellcrafted/result';
import { CliError } from './errors.ts';
import { loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
import { type RunAnswer, refused, stderrJsonLines } from './output.ts';

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

/** Where serve writes one record for each run, when it ends. */
const runLog = createLogger('cli/run', stderrJsonLines);

/**
 * Run a checked action. Nothing locks it: one process runs actions (ADR-0936).
 * When it ends, `log` gets one record: the app, the action, the outcome and
 * how long it took, and for a failure the error's name and message. The
 * record has neither the input nor the result, which can hold personal data.
 */
export async function runAction(
	located: Runnable,
	key: string,
	action: Action,
	input: Record<string, unknown>,
	{ onUpdate, log = runLog }: Following = {},
): Promise<RunAnswer> {
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

/** How a run ended, as its record states it: the error's name and message, none of its other fields. */
function outcomeOf({ error }: RunAnswer) {
	if (error === null) return { outcome: 'ok' as const };
	if (error.kind === 'returned')
		return {
			outcome: 'returned' as const,
			error: { name: error.reason.name, message: error.reason.message },
		};
	const name = error.thrown?.name;
	return {
		outcome: 'fault' as const,
		error: {
			...(typeof name === 'string' && { name }),
			message: error.message,
		},
	};
}

/** Run the action and answer what it did, whether it returned or threw. */
async function settle(
	key: string,
	action: Action,
	input: Record<string, unknown>,
	located: Runnable,
	onUpdate: Following['onUpdate'],
): Promise<RunAnswer> {
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
	/** Where the record of the run's end goes: stderr, as JSON lines, unless a test passes its own. */
	log?: Logger;
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
