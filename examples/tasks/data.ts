import { defineData, field } from "@epicenter/app";

export const data = defineData({
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
