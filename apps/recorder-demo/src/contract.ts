/**
 * The recorder demo's contract: a recording is a note holding its title,
 * when it was recorded and how long it is, beside its audio at the same id.
 * The audio's extension is whatever the browser recorded (`m4a` or `webm`).
 *
 * Its name makes the repository `<account>/recorder-demo` (decision 46). It
 * is published, unchanged, as `public/contract.json` (`bun run contract`
 * writes it), so `epicenter check <url>/contract.json <dir>` checks a clone.
 */
import { defineContract } from '@epicenter/definition/contract';

export const recorder = defineContract({
	name: 'recorder-demo',
	description:
		'Voice recordings: a note per recording, and its audio beside it.',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				recordedAt: { type: 'string' },
				durationMs: { type: 'integer', minimum: 0 },
			},
			required: ['title', 'recordedAt', 'durationMs'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
	},
});

export type Recorder = typeof recorder;
