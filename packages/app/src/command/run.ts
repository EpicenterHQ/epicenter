/**
 * Run actions in serve: find one in the program serve loaded, check its
 * input, and answer what it did. The command, an agent and a page each name
 * an action by its app and its name.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Action } from '../action.ts';
import { type Answer, isPlainObject } from '../answer.ts';
import { ActionError, type NotStarted, type PublicError } from '../errors.ts';
import type { JsonValue } from '../markdown.ts';
import { checkObject, readInput } from './input.ts';
import type { Loaded } from './load.ts';
import { stderrJsonLines } from './output.ts';

/** An action found in the program: its app's name, its own, and what runs. */
export type Found = { app: string; action: string; run: Action };

/** A call ready to run: the action and its checked input. */
export type Call = Found & { input: Record<string, unknown> };

type Thrown = { name: string; message: string } & Record<string, unknown>;

/**
 * The names only Epicenter answers: an action that returns one answers
 * `Threw` instead, so a caller can trust what each says about whether the
 * action ran.
 */
const RESERVED_NAMES = ['NotStarted', 'Threw', 'Unreachable'];

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
 * JSON, or `Threw`. An error it returns named `NotStarted`, `Threw` or
 * `Unreachable` answers `Threw`: only Epicenter says whether a call began.
 * When it ends, serve logs one record: the app, the
 * action, the outcome and how long it took, never the input or the result,
 * which can hold personal data.
 */
export async function runAction(
	{ app, action, run, input }: Call,
	{ onUpdate }: { onUpdate?: (value: unknown) => unknown } = {},
): Promise<Answer> {
	const started = performance.now();
	// defineAction checked that it returned a Result (`isAction`).
	const answer: Answer = await run(input, { onUpdate })
		.then((result) => {
			const encoded = toJsonAnswer(result as Answer);
			return encoded.error && RESERVED_NAMES.includes(encoded.error.name)
				? ActionError.Threw({
						message: `The action "${action}" returned ${encoded.error.name}, a name only Epicenter answers`,
					})
				: encoded;
		})
		.catch((cause) => ActionError.Threw(threw(cause)));
	const { error } = answer;
	try {
		runLog.info('action run ended', {
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

/**
 * `answer` copied to JSON values. `undefined` becomes `null`, a property
 * that is `undefined` is dropped, and anything else JSON would change, such
 * as a `Date`, a `Map`, `NaN` or a cycle, throws.
 */
function toJsonAnswer(answer: Answer): Result<JsonValue, PublicError> {
	const parents = new Set<object>();
	function encode(value: unknown): JsonValue {
		if (value === null || value === undefined) return null;
		if (typeof value === 'string' || typeof value === 'boolean') return value;
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if ((!Array.isArray(value) && !isPlainObject(value)) || parents.has(value))
			throw new TypeError('An action answer must contain only JSON values');
		parents.add(value);
		try {
			if (Array.isArray(value)) return Array.from(value, encode);
			return Object.fromEntries(
				Object.entries(value)
					.filter(([, item]) => item !== undefined)
					.map(([key, item]) => [key, encode(item)]),
			);
		} finally {
			parents.delete(value);
		}
	}
	if (answer.error === null) return Ok(encode(answer.data));
	const error = encode(answer.error) as Record<string, JsonValue>;
	return Err({
		...error,
		name: answer.error.name,
		message: answer.error.message,
	});
}
