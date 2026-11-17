// Synthetic work makes repeat effects, cancellation and interruption observable.
import {
	defineAction,
	field,
	folder,
	callSignal,
	Ok,
	ActionError,
} from '@epicenter/app';
export const review = defineAction({
	description: 'Prepare a task review, yielding each completed step',
	input: {
		key: field.text({ pattern: '^[a-zA-Z0-9-]+$' }),
		steps: field.integer({ min: 1, max: 60 }),
		delayMs: field.integer({ min: 100, max: 2000 }),
	},
	run: async function* ({ key, steps, delayMs }) {
		const signal = callSignal();
		const path = 'data/reviews/' + key + '.json';
		await folder.update(path, (text) => {
			const state = JSON.parse(
				text ?? '{"starts":0,"effects":0,"completed":0}',
			);
			state.starts++;
			return JSON.stringify(state);
		});
		try {
			for (let step = 1; step <= steps; step++) {
				await new Promise<void>((resolve, reject) => {
					const stop = () => {
						clearTimeout(timer);
						reject(new Error('Stopped'));
					};
					const timer = setTimeout(() => {
						signal.removeEventListener('abort', stop);
						resolve();
					}, delayMs);
					if (signal.aborted) stop();
					else signal.addEventListener('abort', stop, { once: true });
				});
				signal.throwIfAborted();
				await folder.update(path, (text) => {
					const state = JSON.parse(text!);
					state.effects++;
					return JSON.stringify(state);
				});
				yield {
					step,
					total: steps,
					message: 'Reviewed step ' + step + ' of ' + steps,
				};
			}
			await folder.update(path, (text) => {
				const state = JSON.parse(text!);
				state.completed++;
				return JSON.stringify(state);
			});
			return Ok({ path, steps });
		} catch (error) {
			if (signal.aborted)
				return ActionError.Stopped({
					message: 'The review was stopped. Completed steps remain saved.',
				});
			throw error;
		}
	},
});

// A rejected progress value must not poison replay for the terminal Result.
export const invalidProgress = defineAction({
	description: 'Prototype regression: reject non-JSON progress',
	input: {},
	run: async function* () {
		yield undefined;
		return Ok(null);
	},
});

// Detect accidental reuse of one app isolate across different people's homes.
let moduleCalls = 0;
export const moduleCounter = defineAction({
	description: 'Synthetic check of per-home JavaScript module isolation',
	input: {},
	run: () => Ok({ calls: ++moduleCalls }),
});
