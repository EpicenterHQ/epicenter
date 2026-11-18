/**
 * Run actions in serve: find one, check its input, and answer what it did.
 * A page and an agent name an action by its key; the command sends its words
 * as typed, and serve finds the action they name (ADR-0961).
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { encodeActionResult, isActionResult } from '../action-result.ts';
import { RESERVED_NAMES } from '../errors.ts';
import {
	type Action,
	ActionError,
	type Answer,
	isName,
	type NotStarted,
} from '../index.ts';
import { type LoadedApp, loadApp } from './apps.ts';
import { checkInput, matchAction, readInput, usageLine } from './input.ts';
import { stderrJsonLines } from './output.ts';
import type { EpicenterRoot } from './root.ts';

/** An action found in its loaded app, by the key its words make. */
export type Found = { app: LoadedApp; key: string; action: Action };

/** A call ready to run: the action and its checked input. */
export type Call = Found & { input: Record<string, unknown> };

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
	{ app, key, action, input }: Call,
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
			app: app.name,
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

const usage = (message: string, next?: string) =>
	ActionError.NotStarted({ cause: 'usage', message, next });

/** `find`'s answer, or `NotStarted` (`internal`) for what it threw: nothing ran. */
async function guarded<T>(
	find: () => Promise<Result<T, NotStarted>>,
): Promise<Result<T, NotStarted>> {
	try {
		return await find();
	} catch (cause) {
		return ActionError.NotStarted({
			cause: 'internal',
			message: extractErrorMessage(cause),
		});
	}
}

/** Load the app's current code and find the action its key names, running nothing. */
export function findAction(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
	key: string,
): Promise<Result<Found, NotStarted>> {
	return guarded(async () => {
		const { data: app, error } = await loadApp(root, name);
		if (error) return Err(error);
		const action = Object.hasOwn(app.actions, key)
			? app.actions[key]
			: undefined;
		if (!action)
			return usage(`${name} has no action "${key}"`, `epicenter ${name}`);
		return Ok({ app, key, action });
	});
}

/**
 * Load the app's current code and find the action the command's words name:
 * the longest run of them that is an action's key. What follows the action's
 * words is `rest`, the input as typed.
 */
export function findWords(
	root: Pick<EpicenterRoot, 'folder'>,
	name: string,
	words: string[],
): Promise<Result<Found & { rest: string[] }, NotStarted>> {
	return guarded(async () => {
		const { data: app, error } = await loadApp(root, name);
		if (error) return Err(error);
		const matched = matchAction(app.actions, words);
		const action = matched && app.actions[matched.key];
		if (matched && action)
			return Ok({ app, key: matched.key, action, rest: matched.rest });
		// The words that could name an action: those before the input.
		const end = words.findIndex((word) => !isName(word));
		const asked = words.slice(0, end < 0 ? undefined : end).join(' ');
		return usage(
			`${name} has no action ${JSON.stringify(asked || words[0] || '')}. Its actions:\n${Object.entries(
				app.actions,
			)
				.map(([key, each]) => usageLine(name, key, each.input))
				.join('\n')}`,
			`epicenter ${name}`,
		);
	});
}

/** Help for checking `found`'s input, after a refusal. */
const helpFor = ({ app, key }: Found) => `epicenter ${app.name} ${key} --help`;

/** Check an input a page or an agent sent as JSON, running nothing. */
export function checkCall(
	found: Found,
	raw: unknown,
): Result<Call, NotStarted> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return usage('The input is not a JSON object');
	const checked = checkInput(found.action.input, raw);
	if ('error' in checked) return usage(checked.error, helpFor(found));
	return Ok({ ...found, input: checked.input });
}

/** Read and check the input the command typed after the action's words, running nothing. */
export function readCall(
	found: Found,
	rest: string[],
): Result<Call, NotStarted> {
	const read = readInput(found.action.input, rest);
	if ('error' in read) return usage(read.error, helpFor(found));
	return Ok({ ...found, input: read.input });
}
