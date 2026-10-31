/**
 * Capture's contract: a capture is a Markdown note at `captures/{id}.md`,
 * the moment it was captured in front matter, and its text and thoughts in
 * the body (`document.ts` reads them). Capture has no settings, so it has no
 * settings note, and no other files.
 *
 * Its name makes the repository `<account>/capture` (decision 46). The app
 * publishes it, unchanged, as `apps/capture/static/contract.json`, so
 * `epicenter check <url>/contract.json <dir>` checks a clone.
 *
 * `capturedAt` is an RFC 3339 date and time, so a note written by hand with
 * an offset (`2026-10-01T10:30:00+08:00`) is as valid as the UTC form the
 * app writes: order captures by the parsed instant, never by the string.
 * Other front matter keys are kept.
 */
import {
	defineContract,
	type InvalidNoteOf,
	type NoteOf,
} from '@epicenter/definition/contract';

export const capture = defineContract({
	name: 'capture',
	description:
		'Capture: a Markdown note per capture, when it was captured in front matter, its text and then its thoughts under "## Thoughts" in the body.',
	collections: {
		captures: {
			path: 'captures/{id}.md',
			fields: {
				capturedAt: { type: 'string', format: 'date-time' },
			},
			required: ['capturedAt'],
		},
	},
});

export type Capture = typeof capture;

/** Capture's one collection: a note per capture. */
export type CaptureNotes = Capture['collections']['captures'];

/** A capture as read: its `id`, `capturedAt`, any other front matter, `body` and `version`. */
export type CaptureNote = NoteOf<CaptureNotes>;

/** A note at a capture's path that does not read as one, with its text. */
export type InvalidCapture = InvalidNoteOf<CaptureNotes>;

/** The file of the capture `id`. */
export const capturePath = (id: string) =>
	capture.collections.captures.path.replace('{id}', id);
