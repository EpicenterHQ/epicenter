/**
 * Run Record Tests
 *
 * `runAction` writes one record when a run ends, so a run whose caller left
 * still leaves a trace in serve's log. The record names the run and how it
 * ended, and holds none of the input or result data, which can be personal.
 *
 * Key behaviors:
 * - Each outcome (ok, returned, fault) writes exactly one `info` record
 * - A failure's record carries its name and message, not its other fields
 * - Neither the input nor the result reaches the record
 * - A logger that throws does not change the answer
 */

import { expect, test } from 'bun:test';
import {
	createMemoryContext,
	defineAction,
	Err,
	field,
	Ok,
} from '@epicenter/app';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Runnable } from './home.ts';
import { runAction } from './run.ts';

const SECRET = 'diary entry 4417';

const notes = {
	name: 'notes',
	context: createMemoryContext(),
} as Runnable;

function run(
	key: string,
	run: (input: { text: string }) => unknown,
	log: Logger,
) {
	const action = defineAction({
		description: key,
		input: { text: field.text() },
		run: run as never,
	});
	return runAction(notes, key, action, { text: SECRET }, { log });
}

function recorder() {
	const { sink, events } = memorySink();
	return { log: createLogger('cli/run', sink), events };
}

test('a run that returns Ok writes one ok record without its input or result', async () => {
	const { log, events } = recorder();
	const answer = await run('save', ({ text }) => Ok({ saved: text }), log);
	expect(expectOk(answer)).toEqual({ saved: SECRET });
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		level: 'info',
		source: 'cli/run',
		data: {
			app: 'notes',
			action: 'save',
			outcome: 'ok',
			durationMs: expect.any(Number),
		},
	});
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

test('a run that returns Err writes one returned record with only its name and message', async () => {
	const { log, events } = recorder();
	const answer = await run(
		'route',
		({ text }) =>
			Err({ name: 'NoRoute', message: 'No route from LAX', asked: text }),
		log,
	);
	expect(expectErr(answer).kind).toBe('returned');
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		action: 'route',
		outcome: 'returned',
		error: { name: 'NoRoute', message: 'No route from LAX' },
	});
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

test('a run that throws writes one fault record with the thrown name and message', async () => {
	const { log, events } = recorder();
	const answer = await run(
		'print',
		({ text }) => {
			throw { name: 'Jammed', message: 'The printer jammed', page: text };
		},
		log,
	);
	expect(expectErr(answer).kind).toBe('fault');
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		action: 'print',
		outcome: 'fault',
		error: { name: 'Jammed', message: 'The printer jammed' },
	});
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

test('a logger that throws leaves the answer unchanged', async () => {
	const throwing: Logger = {
		...createLogger('cli/run', memorySink().sink),
		info() {
			throw new Error('log is broken');
		},
	};
	const answer = await run('save', () => Ok('kept'), throwing);
	expect(expectOk(answer)).toBe('kept');
});
