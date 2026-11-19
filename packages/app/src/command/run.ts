/**
 * Answer one call in serve: find `action` of `app` in the program, check
 * `input` against its schema, run it, and answer what it did. The route, MCP
 * and every caller through them share this one call, so a page, an agent and
 * the command get the one input check (ADR-0953). Nothing is filled: an
 * absent key stays absent, and an action's `run` writes its own default.
 *
 * A call that cannot begin is `NotStarted`. A run answers its own Result as
 * JSON, or `Threw` when it throws, returns what JSON cannot carry, or returns
 * an error named `NotStarted`, `Threw` or `Unreachable`: only Epicenter says
 * whether a call began. When a run ends, serve logs one record: the app, the
 * action, the outcome and how long it took, never the input or the result,
 * which can hold personal data.
 */

import { Value } from 'typebox/value';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, trySync } from 'wellcrafted/result';
import {
	ActionError,
	type Answer,
	PLATFORM_NAMES,
	type Thrown,
} from '../answer.ts';
import { type ObjectSchema, whatFits } from '../field.ts';
import { isPlainObject } from '../json.ts';
import { stderrJsonLines } from './output.ts';
import type { Program } from './program.ts';

/** Where serve writes one record for each run, when it ends. */
const runLog = createLogger('epicenter/run', stderrJsonLines);

export async function answerCall(
	program: Program,
	app: string,
	action: string,
	input: unknown,
	onUpdate?: (value: unknown) => unknown,
): Promise<Answer> {
	if (program.problem)
		return ActionError.NotStarted({
			message: `${program.problem}\nFix it, then restart serve.`,
		});
	const found = Object.hasOwn(program.apps, app)
		? program.apps[app]
		: undefined;
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
	const problem = inputProblem(run.input, input);
	if (problem !== undefined)
		return ActionError.NotStarted({
			message: problem,
			next: `epicenter ${app}`,
		});
	const started = performance.now();
	// defineAction checked that it returned a Result (`isAction`).
	const answer: Answer = await run(input, { onUpdate })
		.then((result) => {
			const { data, error } = result as Answer;
			if (error && PLATFORM_NAMES.includes(error.name))
				return ActionError.Threw({
					message: `The action "${action}" returned ${error.name}, a name only Epicenter answers`,
				});
			// JSON's own copy: undefined is null, and a cycle or a BigInt throws.
			return JSON.parse(
				JSON.stringify({ data: data ?? null, error }),
			) as Answer;
		})
		.catch((cause) => ActionError.Threw(describeThrown(cause)));
	try {
		runLog.info('action run ended', {
			app,
			action,
			durationMs: Math.round(performance.now() - started),
			...(answer.error === null
				? { outcome: 'ok' }
				: { outcome: 'error', error: answer.error.name }),
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
function describeThrown(cause: unknown): { message: string; thrown?: Thrown } {
	// Even extracting a message can fail, for a cyclic array or a getter.
	const { data: message } = trySync({
		try: () => extractErrorMessage(cause).slice(0, 4096),
		catch: () => Ok('The action threw a value that could not be read'),
	});
	try {
		if (typeof cause !== 'object' || cause === null || cause instanceof Error)
			return { message };
		const json = JSON.stringify(cause);
		const copy: unknown = json.length > 4096 ? undefined : JSON.parse(json);
		if (
			isPlainObject(copy) &&
			typeof copy.name === 'string' &&
			typeof copy.message === 'string'
		)
			return { message, thrown: copy as Thrown };
	} catch {
		// Details are best effort.
	}
	return { message };
}

/**
 * Why `value` is not an input `schema` takes, in words a caller reads, or
 * undefined when it is one. A key the action does not take is refused,
 * naming the keys it does.
 */
function inputProblem(schema: ObjectSchema, value: unknown) {
	if (Value.Check(schema, value)) return undefined;
	if (!isPlainObject(value)) return 'The input is not one JSON object';
	const keys = Object.keys(schema.properties);
	const unknown = Object.keys(value).find((key) => !keys.includes(key));
	if (unknown !== undefined)
		return `${JSON.stringify(unknown)} is not a key this action takes; ${keys.length ? `it takes ${keys.join(', ')}` : 'it takes none'}`;
	const first = Value.Errors(schema, value)[0];
	const params = first?.params as { requiredProperties?: string[] } | undefined;
	const at = (first?.instancePath.split('/').slice(1) ?? []).map((part) =>
		part.replace(/~1/g, '/').replace(/~0/g, '~'),
	);
	const field = at[0] || params?.requiredProperties?.[0];
	const name = field ?? 'input';
	// A key missing inside an object is named by its path: `address.city is needed`.
	if (first?.keyword === 'required')
		return `${[...at, params?.requiredProperties?.[0]].filter(Boolean).join('.') || name} is needed`;
	const fieldSchema = field ? schema.properties[field] : undefined;
	const words = field && fieldSchema && whatFits(fieldSchema, value[field]);
	if (words) return `${name} must be ${words}`;
	return `${name}: ${first?.message ?? 'is not accepted'}`;
}
