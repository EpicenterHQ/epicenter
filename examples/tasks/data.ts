import { defineData, type Folder, field } from "@epicenter/app";

/** Tasks' records in `folder`: one Markdown file per task under data/tasks/. */
export const tasksData = (folder: Folder) =>
	defineData(folder, {
		tasks: {
			description: "task",
			fields: {
				title: field.text({
					pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
					description: "one line, not blank, saying what to do",
				}),
				done: field.boolean({ description: "Whether it is done" }),
				due: field.date({
					optional: true,
					description: "The day it is due, as 2026-11-10; absent when it has none",
				}),
			},
		},
	});
