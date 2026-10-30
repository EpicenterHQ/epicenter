/**
 * Whispering's contract: the folder layout its tables already write, stated
 * as plain data any program can check (`epicenter check <url>/contract.json
 * <dir>`). Each table is a note collection at `<table>/{id}.md` whose fields
 * are the table's own schema (`definition.ts`; `contract.test.ts` fails when
 * they differ), and a recording's audio is the file beside its note, with
 * whatever extension its bytes call for (`webm` or `m4a` from a browser,
 * `wav` from the desktop).
 *
 * Its name makes the repository `<account>/whispering` (one repository per
 * app). Nothing opens it yet: the app still reads and writes through the
 * table API. It is published, unchanged, as `static/contract.json`
 * (`bun run contract` writes it).
 */
import { defineContract } from '@epicenter/definition/contract';

/** An instant as the table API writes it: UTC, to the millisecond. */
const instant = {
	type: 'string',
	format: 'date-time',
	pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
} as const;

export const whispering = defineContract({
	name: 'whispering',
	description:
		'Voice notes: a note per recording beside its audio, its transcripts, reusable recipes, and the results of applying them.',
	collections: {
		recordings: {
			path: 'recordings/{id}.md',
			fields: {
				title: { type: 'string' },
				recordedAt: instant,
				durationMs: { type: 'number' },
				capture: { enum: ['microphone', 'fixture'] },
			},
			required: ['title', 'recordedAt', 'capture'],
		},
		audio: { path: 'recordings/{id}.{ext}' },
		transcriptions: {
			path: 'transcriptions/{id}.md',
			fields: {
				recordingId: { type: 'string' },
				createdAt: instant,
				model: { type: 'string' },
				endpoint: { type: 'string' },
			},
			required: ['recordingId', 'createdAt', 'model', 'endpoint'],
		},
		transformations: {
			path: 'transformations/{id}.md',
			fields: {
				title: { type: 'string' },
				model: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			},
			required: ['title', 'model'],
		},
		transformation_runs: {
			path: 'transformation_runs/{id}.md',
			fields: {
				recordingId: { type: 'string' },
				transcriptionId: { type: 'string' },
				transformationId: { type: 'string' },
				transformationTitle: { type: 'string' },
				createdAt: instant,
				model: { type: 'string' },
				endpoint: { type: 'string' },
				prompt: { type: 'string' },
				input: { type: 'string' },
			},
			required: [
				'recordingId',
				'transcriptionId',
				'transformationId',
				'transformationTitle',
				'createdAt',
				'model',
				'endpoint',
				'prompt',
				'input',
			],
		},
		text_runs: {
			path: 'text_runs/{id}.md',
			fields: {
				transformationId: { type: 'string' },
				transformationTitle: { type: 'string' },
				createdAt: instant,
				model: { type: 'string' },
				endpoint: { type: 'string' },
				prompt: { type: 'string' },
				input: { type: 'string' },
			},
			required: [
				'transformationId',
				'transformationTitle',
				'createdAt',
				'model',
				'endpoint',
				'prompt',
				'input',
			],
		},
	},
});

export type Whispering = typeof whispering;
