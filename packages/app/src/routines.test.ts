/**
 * Typed routine authoring uses the current run's host capability.
 * Inputs follow the chosen action; a host that keeps no routines refuses.
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { defineAction } from './action.ts';
import { type Context, inRun, routines } from './context.ts';
import { field } from './field.ts';
import { createMemoryContext } from './memory.ts';

test('the action controls input inference and the current host receives the same reference', async () => {
	const action = defineAction({
		description: 'Research',
		input: { limit: field.number() },
		run: ({ limit }) => Ok(limit),
	});
	let received: unknown;
	const context: Context = {
		...createMemoryContext(),
		routines: {
			async set(name, routine) {
				received = routine;
				return { name, path: `routines/${name}.md` };
			},
		},
	};
	const result = await inRun(context, () =>
		routines.set('research', { daily: '08:00', action, input: { limit: 3 } }),
	);
	expect(result.path).toBe('routines/research.md');
	expect(received).toEqual({ daily: '08:00', action, input: { limit: 3 } });
	const invalidInputs = () => {
		void routines.set('research', {
			daily: '08:00',
			action,
			// @ts-expect-error: the action requires a numeric limit
			input: { limit: 'three' },
		});
		// @ts-expect-error: the action requires limit
		void routines.set('research', { daily: '08:00', action, input: {} });
	};
	void invalidInputs;
});

test('a host that keeps no routines cannot save one', async () => {
	const action = defineAction({
		description: 'Research',
		input: {},
		run: () => Ok(null),
	});
	const routine = { daily: '08:00', action, input: {} };
	await expect(
		inRun(createMemoryContext(), () => routines.set('research', routine)),
	).rejects.toThrow('This host cannot');
});
