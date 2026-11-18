/** Run actions: find one, check its input, and answer what it did. */

import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { encodeActionResult, isActionResult } from '../action-result.ts';
import { RESERVED_NAMES } from '../errors.ts';
import { type Action, ActionError, type Answer, Err } from '../index.ts';
import { loadHomeApp, type Runnable } from './home.ts';
import { checkInput } from './input.ts';
import { stderrJsonLines } from './output.ts';
import type { EpicenterRoot } from './root.ts';

type Thrown = { name: string; message: string } & Record<string, unknown>;

/** Where serve writes one record for each run, when it ends. */
const runLog = createLogger('cli/run', stderrJsonLines);

/**
 * Run a checked action and answer what it did: its own Result, or `Threw`.
 * An error it returns named `NotStarted` or `Unreachable` answers `Threw`:
 * only Epicenter says a call never began or that its outcome is unknown, and
 * the name alone says so (ADR-0953). Nothing locks it: one process runs
 * actions (ADR-0936).
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
	let answer: Answer;
	try {
		const result = await action(input, { onUpdate });
		// An action made without `defineAction` is checked here, where every call passes.
		if (!isActionResult(result))
			throw new TypeError(
				`The action "${key}" must return Ok(data) or Err(error)`,
			);
		const encoded = encodeActionResult(result);
		answer =
			encoded.error && RESERVED_NAMES.includes(encoded.error.name)
				? ActionError.Threw({
						message: `The action "${key}" returned ${encoded.error.name}, a name only Epicenter answers`,
					})
				: encoded;
	} catch (cause) {
		// What the action threw, as `Threw` carries it. A thrown tagged error (a
		// frozen `{ name, message, ...fields }`, as wellcrafted's `defineErrors`
		// makes) is kept whole when it survives JSON. A value that cannot be read
		// or serialized still answers as an action throw, with a safe message.
		let message = 'The action threw a value that could not be read';
		try {
			message = extractErrorMessage(cause).slice(0, 4096);
		} catch {
			// Even extracting a message can fail for a cyclic array or a getter.
		}
		let thrown: Thrown | undefined;
		try {
			if (
				typeof cause === 'object' &&
				cause !== null &&
				!(cause instanceof Error)
			) {
				const json = JSON.stringify(cause);
				const copy: unknown = json.length > 4096 ? undefined : JSON.parse(json);
				if (
					typeof copy === 'object' &&
					copy !== null &&
					!Array.isArray(copy) &&
					'name' in copy &&
					typeof copy.name === 'string' &&
					'message' in copy &&
					typeof copy.message === 'string'
				)
					thrown = copy as Thrown;
			}
		} catch {
			// Error details are best effort; they must not prevent the call's answer.
		}
		answer = ActionError.Threw(thrown ? { message, thrown } : { message });
	}
	// The record states a failure by the error's name as the answer carries it,
	// and for `Threw` the thrown value's name when it has one. A message can
	// quote what the person typed, so it stays out.
	const { error } = answer;
	const thrownName = (error as { thrown?: { name?: unknown } } | null)?.thrown
		?.name;
	try {
		log.info('action run ended', {
			app: located.name,
			action: key,
			durationMs: Math.round(performance.now() - started),
			...(error === null
				? { outcome: 'ok' }
				: {
						outcome: 'error',
						error: error.name,
						...(typeof thrownName === 'string' && { thrown: thrownName }),
					}),
		});
	} catch {
		// The record is for the owner; it must not change the caller's answer.
	}
	return answer;
}

/** Who follows a call as it runs. */
type Following = {
	/** Each update the action sends, in order. The action never waits for it. */
	onUpdate?: (value: unknown) => unknown;
	/** Where the record of the run's end goes: stderr, as JSON lines, unless a test passes its own. */
	log?: Logger;
};

/** A call that is ready to run, or the `NotStarted` that answers it instead. */
type Resolved =
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
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
	key: string,
	raw: unknown,
): Promise<Resolved> {
	const usage = (message: string, next?: string) => ({
		refusal: ActionError.NotStarted({ cause: 'usage', message, next }),
	});
	try {
		const { data: located, error: notLoaded } = await loadHomeApp(root, name);
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
