import {
	ActionError,
	defineAction,
	defineApp,
	timeId,
	field,
} from "@epicenter/app";

import { data } from "./data.ts";

/** `add`: a title of several lines keeps its first line as the title. */
const add = defineAction({
	description:
		"Add a task to do: a new data/tasks/<time>.md, named by the time. A title of several lines keeps its first line as the title and the rest as notes",
	input: {
		title: field.text({ description: "What to do" }),
		due: field.date({ optional: true, description: "The day it is due" }),
		notes: field.text({ optional: true, description: "Notes in Markdown" }),
	},
	annotations: { destructiveHint: false, openWorldHint: false },
	run: async ({ title, due, notes }) => {
		const [first = "", ...rest] = title.trim().split(/\r?\n/);
		const heading = first.trim();
		if (heading === "") return ActionError.Refused({ message: "A task needs a title" });
		const body = [rest.join("\n").trim(), notes?.trim() ?? ""]
			.filter((part) => part !== "")
			.join("\n\n");
		return data.tasks.add(timeId(), {
			title: heading,
			done: false,
			due,
			body: body === "" ? "" : `${body}\n`,
		});
	},
});

export default defineApp({
	description:
		"Things I mean to do: a note per task, its title, whether it is done, and when it is due; its notes in the body",
	data,
	// One data key: its verbs are the app's own, `tasks add` rather than `tasks tasks add`.
	actions: { ...data.tasks.actions("list", "get", "set", "delete"), add },
});
