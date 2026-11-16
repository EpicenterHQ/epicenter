/** Type checks for ordinary actions, file inputs, run controls, and yields. */
import { expect, test } from 'bun:test';
import { defineAction } from './action.ts';
import { type ActionRun, connect, runs } from './client.ts';
import { field } from './field.ts';

const upload = defineAction({
	description: 'Upload',
	input: { file: field.file() },
	async *run() {
		yield 1 as const;
		return 'done';
	},
});
const empty = defineAction({
	description: 'Empty',
	input: {},
	run: () => null,
});
const app = connect<{
	actions: {
		upload: typeof upload;
		daily: { start: typeof empty };
		practice: { start: typeof empty };
	};
}>({ app: 'types' });
// Typecheck these calls without making network requests during bun test.
function clientUsage() {
	void app.upload(
		{ file: new Blob() },
		{
			onYield: (value) => {
				const one: 1 = value;
				void one;
			},
		},
	);
	// @ts-expect-error A file input accepts Blob, not a path.
	void app.upload({ file: 'file.txt' });
	void app.upload(
		{ file: new Blob() },
		// @ts-expect-error Ordinary calls have no observer signal.
		{ signal: new AbortController().signal },
	);
	// @ts-expect-error Non-yielding ordinary calls have no options.
	void app.daily.start({}, { signal: new AbortController().signal });
	void app.daily.start({});
	void app.practice.start({});
	const run: ActionRun<typeof upload> = runs.start(app.upload, {
		file: new Blob(),
	});
	void run.events({ signal: new AbortController().signal });
	// @ts-expect-error Observers replay the run; offsets belong to the transport.
	void run.events({ after: 1 });
	void run.result({
		onYield: (value) => {
			const one: 1 = value;
			void one;
		},
	});
	void runs.start(app.daily.start, {});
	// @ts-expect-error Runs are not thenable.
	void run.then;
}
test('client type assertions compile', () =>
	expect(clientUsage).toBeFunction());
