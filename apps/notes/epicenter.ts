import {
	defineAction,
	defineApp,
	defineCollection,
	field,
} from '@epicenter/app';

/** `at` as RFC 3339 in this computer's offset: `2026-11-10T22:41:05+08:00`. */
function localTime(at: Date): string {
	const offset = -at.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
	const local = new Date(at.getTime() + offset * 60_000)
		.toISOString()
		.slice(0, 19);
	return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** Matches the `{time}` names Capture and Tasks get, so ordinary notes sort by when they were made. */
function timeName(at = new Date()): string {
	const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
	const random = crypto.getRandomValues(new Uint8Array(8));
	return `${at
		.toISOString()
		.replace(/\.(\d{3})Z$/, '-$1Z')
		.replaceAll(
			':',
			'-',
		)}-${Array.from(random, (n) => alphabet[n % alphabet.length]).join('')}`;
}

/** A Capture record's path, as `capture_get` takes it. */
const CAPTURE = '^captures/[^./\\\\][^/\\\\]*\\.md$';

const notes = defineCollection({
	path: 'notes/{name}.md',
	description: 'note',
	fields: {
		title: field.text({
			optional: true,
			pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$',
			description: 'one line, not blank',
		}),
		createdAt: field.datetime({
			optional: true,
			readOnly: true,
			description: 'When it was made, RFC 3339 with an offset',
		}),
		capture: field.text({
			optional: true,
			readOnly: true,
			pattern: CAPTURE,
			description:
				'the path of the capture it was made from, as captures/<time>.md',
		}),
	},
});

const add = defineAction({
	description:
		'Make a note, notes/<name>.md, with a title and a Markdown body. With `capture`, the path of the capture it develops (captures/<time>.md, the path capture_get takes), the note is notes/capture-<time>.md and keeps that path; adding again with the same capture makes nothing and returns the note already made from it, with `added: false`. Change a note afterwards with set (title) and edit (body). Notes never reads or changes the capture.',
	input: {
		title: field.text({ optional: true, description: 'Title, one line' }),
		body: field.text({ optional: true, description: 'Body in Markdown' }),
		capture: field.text({
			optional: true,
			pattern: CAPTURE,
			description: 'The capture it develops, as captures/<time>.md',
		}),
	},
	positional: ['title'],
	annotations: { destructiveHint: false, openWorldHint: false },
	run: async ({ title, body = '', capture }) => {
		title = title?.trim() || undefined;
		if (title && /[\r\n]/.test(title))
			throw new Error('A note title is one line');
		let name: string;
		if (capture !== undefined) {
			if (!new RegExp(CAPTURE).test(capture))
				throw new Error(
					`${JSON.stringify(capture)} is not a capture's path, as captures/<time>.md`,
				);
			for (const row of await notes.list()) {
				if (row.capture !== capture) continue;
				const there = await notes.get({ path: row.path });
				if (there) return { ...there, added: false };
			}
			name = `capture-${capture.slice('captures/'.length, -3)}`;
		} else name = timeName();
		if (body !== '' && !body.endsWith('\n')) body += '\n';
		try {
			return {
				...(await notes.add({
					name,
					title,
					createdAt: localTime(new Date()),
					capture,
					body,
				})),
				added: true,
			};
		} catch (error) {
			if (capture !== undefined) {
				const there = await notes.get({ path: notes.pathOf({ name }) });
				if (there) return { ...there, added: false };
			}
			throw error;
		}
	},
});

export default defineApp({
	description:
		'Notes I write and develop: a Markdown note per file, its title, and the capture it came from when it came from one',
	collections: { notes },
	// One collection: its verbs are the app's own, `notes add` rather than `notes notes add`.
	actions: { ...notes.actions(), add },
});
