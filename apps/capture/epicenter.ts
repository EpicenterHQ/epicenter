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

/** How much of a capture's text `recent` returns. */
const PREVIEW = 280;

const captures = defineCollection({
	path: 'captures/{time}.md',
	description: 'capture',
	fields: {
		capturedAt: field.datetime({
			readOnly: true,
			description: 'When it was captured, RFC 3339 with an offset',
		}),
	},
});

/**
 * What a list shows of a capture's body: its text, cut at `PREVIEW`
 * characters, and how many thoughts it has. A rough reading for a list, not
 * the body codec the UI edits with: the text is everything before a
 * `## Thoughts` line, and a thought is a line under it that starts with a
 * bullet, up to the next heading.
 */
export function preview(body: string): { text: string; thoughts: number } {
	const heading = /^## Thoughts[ \t]*$/m.exec(body);
	const whole = (heading ? body.slice(0, heading.index) : body).trim();
	const text =
		whole.length > PREVIEW ? `${whole.slice(0, PREVIEW).trimEnd()}…` : whole;
	if (!heading) return { text, thoughts: 0 };
	const section = body.slice(heading.index + heading[0].length);
	const end = /^#{1,2}[ \t]/m.exec(section)?.index ?? section.length;
	const thoughts = section.slice(0, end).match(/^[-*+][ \t]/gm)?.length ?? 0;
	return { text, thoughts };
}

/** The moment `capturedAt` names, or -Infinity when there is none, so those sort last. */
function instant(capturedAt: string | undefined): number {
	const at = capturedAt === undefined ? Number.NaN : Date.parse(capturedAt);
	return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

const add = defineAction({
	description:
		'Capture something now: a new captures/<time>.md holding the text, named by the time',
	input: { text: field.text() },
	positional: ['text'],
	annotations: { destructiveHint: false, openWorldHint: false },
	run: ({ text }) =>
		captures.add({
			capturedAt: localTime(new Date()),
			body: text.endsWith('\n') ? text : `${text}\n`,
		}),
});

const recent = defineAction({
	description:
		'The newest captures by capturedAt, at most `limit` (50 unless given), each as its path, capturedAt, the start of its text, and its number of thoughts. `matching` keeps only files that contain it, ignoring case; `total` counts every capture kept.',
	input: {
		limit: field.number({ optional: true }),
		matching: field.text({ optional: true }),
	},
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async ({ limit = 50, matching }) => {
		const needle = matching?.trim().toLowerCase() || undefined;
		const found: {
			path: string;
			capturedAt: string | undefined;
			body: string;
			at: number;
		}[] = [];
		for (const { path } of await captures.list()) {
			const read = await captures.get({ path });
			if (!read) continue;
			if (needle && !read.body.toLowerCase().includes(needle)) continue;
			// A file written by hand may have no capturedAt, or one that is not a date and time; a read leaves it out.
			const { capturedAt } = read;
			found.push({
				path,
				capturedAt,
				body: read.body,
				at: instant(capturedAt),
			});
		}
		// Newest first; ties, and captures with no date, by path, newest first.
		found.sort(
			(a, b) => b.at - a.at || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0),
		);
		return {
			total: found.length,
			captures: found
				.slice(0, Math.max(0, Math.floor(limit)))
				.map(({ path, capturedAt, body }) => ({
					path,
					capturedAt,
					...preview(body),
				})),
		};
	},
});

const app = defineApp({
	description:
		'Things I want to keep: a note per capture, with my thoughts on it',
	collections: { captures },
	// One collection: its verbs are the app's own, `capture add` rather than `capture captures add`.
	actions: { ...captures.actions(), add, recent },
});

export default app;

/** What `recent` returns, for the UI. */
export type Recent = Awaited<ReturnType<typeof recent>>;
