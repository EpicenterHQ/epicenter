/**
 * Verifies Tasks actions against the installed app contract: valid task files,
 * title validation, field updates, and guarded notes edits.
 */
import { expect, test } from "bun:test";
import { createMemoryContext, inRun } from "@epicenter/app";
import tasks from "./epicenter.ts";

const { add } = tasks.actions;

test("add writes a task the collection reads, with an optional due day", async () => {
	const context = createMemoryContext({});
	const added = await inRun(context, () =>
		add({ title: "Buy milk", due: "2026-11-12" }),
	);
	expect(added).toMatchObject({
		title: "Buy milk",
		done: false,
		due: "2026-11-12",
	});
	expect(added.path).toMatch(/^data\/tasks\/.+\.md$/);
	expect(await context.folder.read(added.path)).toBe(
		'---\ntitle: "Buy milk"\ndone: false\ndue: "2026-11-12"\n---\n',
	);
});

test("add keeps the first line as the title and the rest, then notes, as the body", async () => {
	const context = createMemoryContext({});
	const added = await inRun(context, () =>
		add({ title: "Call Mom\nabout the trip", notes: "Ask about Sunday" }),
	);
	expect(await context.folder.read(added.path)).toBe(
		'---\ntitle: "Call Mom"\ndone: false\n---\nabout the trip\n\nAsk about Sunday\n',
	);
});

test("add refuses an empty title", async () => {
	await expect(
		inRun(createMemoryContext({}), () => add({ title: "  \n" })),
	).rejects.toThrow("A task needs a title");
});

test("the collection gives the other verbs, by path", async () => {
	const context = createMemoryContext({
		"data/tasks/a.md": '---\ntitle: "Water the plants"\ndone: false\n---\n',
	});
	const { set, list } = tasks.actions;
	await inRun(context, () => set({ path: "data/tasks/a.md", done: true }));
	expect(await inRun(context, () => list({}))).toEqual([
		{
			path: "data/tasks/a.md",
			time: "a",
			title: "Water the plants",
			done: true,
		},
	]);
});

test("set refuses a title of several lines, or a blank one, as add keeps one", async () => {
	const text = '---\ntitle: "Water the plants"\ndone: false\n---\n';
	const context = createMemoryContext({ "data/tasks/a.md": text });
	const { set } = tasks.actions;
	for (const title of ["Water\nthe plants", "   "])
		await expect(
			inRun(context, () => set({ path: "data/tasks/a.md", title })),
		).rejects.toThrow(
			`data/tasks/a.md: title: ${JSON.stringify(title)} is not one line, not blank, saying what to do`,
		);
	expect(await context.folder.read("data/tasks/a.md")).toBe(text);
});

test("title, due removal, completion, reopening, and notes survive fresh reads", async () => {
	const context = createMemoryContext({});
	const { get, set, edit, note } = tasks.actions;
	const added = await inRun(context, () =>
		add({ title: "Plan the morning", notes: "First draft" }),
	);
	await inRun(context, () =>
		set({
			path: added.path,
			title: "Share the agenda",
			due: "2026-11-14",
			done: true,
		}),
	);
	await inRun(context, () =>
		note({ path: added.path, body: "Ready to share\n" }),
	);
	expect(await inRun(context, () => get({ path: added.path }))).toMatchObject({
		title: "Share the agenda",
		due: "2026-11-14",
		done: true,
		body: "Ready to share\n",
	});
	await inRun(context, () => set({ path: added.path, due: null, done: false }));
	const reopened = await inRun(context, () => get({ path: added.path }));
	expect(reopened).toMatchObject({
		title: "Share the agenda",
		done: false,
		body: "Ready to share\n",
	});
	expect(reopened.due).toBeUndefined();
	await expect(
		inRun(context, () =>
			edit({
				path: added.path,
				old: "First draft\n",
				new: "Stale overwrite\n",
			}),
		),
	).rejects.toThrow();
	expect((await inRun(context, () => get({ path: added.path }))).body).toBe(
		"Ready to share\n",
	);
});

test("note preserves fields and replaces or clears the body", async () => {
	const path = "data/tasks/a.md";
	const front =
		'---\ntitle: "Keep fields"\ndone: true\ndue: "2026-11-14"\n---\n';
	const context = createMemoryContext({ [path]: `${front}Old notes\n` });
	await inRun(context, () => tasks.actions.note({ path, body: "New notes\n" }));
	expect(await context.folder.read(path)).toBe(`${front}New notes\n`);
	await inRun(context, () => tasks.actions.note({ path, body: "" }));
	expect(await context.folder.read(path)).toBe(front);
});

test("note refuses a missing task without creating it", async () => {
	const path = "data/tasks/missing.md";
	const context = createMemoryContext({});
	await expect(
		inRun(context, () => tasks.actions.note({ path, body: "No task" })),
	).rejects.toThrow();
	expect(await context.folder.read(path)).toBeUndefined();
});
