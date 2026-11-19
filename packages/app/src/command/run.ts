/**
 * Run actions in serve: find one in the program serve loaded, check its
 * input, and answer what it did. The command, an agent and a page each name
 * an action by its app and its name.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { Action } from '../action.ts';
import { ActionError, type NotStarted, RESERVED_NAMES } from '../errors.ts';
import { type Answer, isAnswer, toJsonAnswer } from '../result.ts';
import { checkObject, readInput } from './input.ts';
import type { Loaded } from './load.ts';
import { stderrJsonLines } from './output.ts';

/** An action found in the program: its app's name, its own, and what runs. */
type Found = { app: string; action: string; run: Action };

/** A call ready to run: the action and its checked input. */
export type Call = Found & { input: Record<string, unknown> };

type Thrown = { name: string; message: string } & Record<string, unknown>;

/** Where serve writes one record for each run, when it ends. */
const runLog = createLogger('epicenter/run', stderrJsonLines);

/** The action `action` of `app` in what serve loaded, running nothing. */
export function findAction(
	loaded: Loaded,
	app: string,
	action: string,
): Result<Found, NotStarted> {
	if (!loaded.epicenter)
		return ActionError.NotStarted({
			message: `${loaded.problem}\nFix it, then restart serve.`,
		});
	const { apps } = loaded.epicenter;
	const found = Object.hasOwn(apps, app) ? apps[app] : undefined;
	if (!found)
		return ActionError.NotStarted({
			message: `There is no app "${app}"`,
			next: 'epicenter',
		});
	const run = Object.hasOwn(found.actions, action)
		? found.actions[action]
		: undefined;
	if (!run) {
		const names = Object.keys(found.actions);
		return ActionError.NotStarted({
			message: `${app} has no action ${JSON.stringify(action)}; ${names.length ? `its actions: ${names.join(', ')}` : 'it has none'}`,
			next: `epicenter ${app}`,
		});
	}
	return Ok({ app, action, run });
}

/**
 * Check a call's input, running nothing: the JSON text a page or the command
 * sent, or the object an agent did.
 */
export function checkCall(
	found: Found,
	sent: { text: string } | { value: unknown },
): Result<Call, NotStarted> {
	const { input } = found.run;
	const checked =
		'text' in sent
			? readInput(input, sent.text)
			: checkObject(input, sent.value);
	if ('error' in checked)
		return ActionError.NotStarted({
			message: checked.error,
			next: `epicenter ${found.app}`,
		});
	return Ok({ ...found, input: checked.input });
}

/**
 * Run a checked action and answer what it did: its own Result copied to
 * JSON, or `Threw`. An error it returns named `NotStarted` or `Unreachable`
 * answers `Threw`: only Epicenter says a call never began or that its
 * outcome is unknown. When it ends, `log` gets one record: the app, the
 * action, the outcome and how long it took, never the input or the result,
 * which can hold personal data.
 */
export async function runAction(
	{ app, action, run, input }: Call,
	{
		onUpdate,
		log = runLog,
	}: { onUpdate?: (value: unknown) => unknown; log?: Logger } = {},
): Promise<Answer> {
	const started = performance.now();
	let answer: Answer;
	try {
		const result = await run(input, { onUpdate });
		if (!isAnswer(result))
			throw new TypeError(
				`The action "${action}" must return Ok(data) or Err(error)`,
			);
		const encoded = toJsonAnswer(result);
		answer =
			encoded.error && RESERVED_NAMES.includes(encoded.error.name)
				? ActionError.Threw({
						message: `The action "${action}" returned ${encoded.error.name}, a name only Epicenter answers`,
					})
				: encoded;
	} catch (cause) {
		answer = ActionError.Threw(threw(cause));
	}
	const { error } = answer;
	try {
		log.info('action run ended', {
			app,
			action,
			durationMs: Math.round(performance.now() - started),
			...(error === null
				? { outcome: 'ok' }
				: { outcome: 'error', error: error.name }),
		});
	} catch {
		// The record is for the owner; it must not change the caller's answer.
	}
	return answer;
}

/**
 * What a thrown value becomes in `Threw`: its message, and the value itself
 * when it is a tagged error (`{ name, message, ... }`) that survives JSON.
 * Reading a hostile value never stops the answer.
 */
function threw(cause: unknown): { message: string; thrown?: Thrown } {
	let message = 'The action threw a value that could not be read';
	try {
		message = extractErrorMessage(cause).slice(0, 4096);
	} catch {
		// Even extracting a message can fail, for a cyclic array or a getter.
	}
	try {
		if (typeof cause !== 'object' || cause === null || cause instanceof Error)
			return { message };
		const json = JSON.stringify(cause);
		const copy: unknown = json.length > 4096 ? undefined : JSON.parse(json);
		if (
			typeof copy === 'object' &&
			copy !== null &&
			!Array.isArray(copy) &&
			typeof (copy as Thrown).name === 'string' &&
			typeof (copy as Thrown).message === 'string'
		)
			return { message, thrown: copy as Thrown };
	} catch {
		// Details are best effort.
	}
	return { message };
}
