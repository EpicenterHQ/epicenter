/**
 * Typing into the open todo's title while 1,000 todos are listed: the time
 * per keystroke, with Todos' own components (`TodoList` beside
 * `TodoDetail`) over the folder in memory, as the page has them.
 *
 *   bun --conditions=browser --conditions=svelte --conditions=test \
 *     src/__benchmarks__/typing.bench.ts
 *
 * - burst: a keystroke delivered and flushed, timed alone, with saves left
 *   to coalesce behind the typing (what a fast typist feels).
 * - paced: a keystroke, then until the list row shows it (the save landed
 *   and the list redrew), timed together.
 *
 * It reads and writes only through the DOM and `folder.todos.set`, so it
 * measures any version of the components and the folder.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { folder } = await import('../lib/app.js');
const { default: TodoList } = await import('../lib/components/TodoList.svelte');
const { default: TodoDetail } = await import(
	'../lib/components/TodoDetail.svelte'
);

const COUNT = 1000;
const OPEN = '0500';
const ROUNDS = 5;

const idOf = (index: number) => String(index).padStart(4, '0');
for (let index = 0; index < COUNT; index++)
	await folder.todos.set(
		{ id: idOf(index) },
		{ title: `Todo ${index}`, done: index % 3 === 0 },
	);

const main = document.createElement('main');
document.body.append(main);
const list = mount(TodoList, { target: main, props: {} });
const detail = mount(TodoDetail, { target: main, props: { id: OPEN } });

async function until(check: () => boolean) {
	for (let turn = 0; turn < 10_000 && !check(); turn++) {
		await Bun.sleep(0);
		flushSync();
	}
	if (!check()) throw new Error('timed out');
}

const row = () =>
	main.querySelector(`[data-todo="${OPEN}"]`)?.textContent?.trim() ?? '';
await until(
	() => main.querySelectorAll('[data-todo]').length === COUNT && row() !== '',
);
const input = main.querySelector<HTMLInputElement>('input[aria-label="Title"]');
if (input === null) throw new Error('no title input');

let typed = 'Todo 500';
function keystroke() {
	typed += 'x';
	input!.value = typed;
	input!.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

const percentile = (values: number[], p: number) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};
const report = (name: string, values: number[]) =>
	console.log(
		`${name.padEnd(6)} n=${values.length}  median ${percentile(values, 50).toFixed(3)} ms  p95 ${percentile(values, 95).toFixed(3)} ms  mean ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)} ms`,
	);

// Warm up both paths.
for (let index = 0; index < 20; index++) keystroke();
await until(() => row() === typed);

const burst: number[] = [];
const paced: number[] = [];
for (let round = 0; round < ROUNDS; round++) {
	for (let index = 0; index < 100; index++) {
		const start = performance.now();
		keystroke();
		burst.push(performance.now() - start);
	}
	await until(() => row() === typed);

	for (let index = 0; index < 40; index++) {
		const start = performance.now();
		keystroke();
		await until(() => row() === typed);
		paced.push(performance.now() - start);
	}
}

report('burst', burst);
report('paced', paced);
await unmount(detail);
await unmount(list);
process.exit(0);
