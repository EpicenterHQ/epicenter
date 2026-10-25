/** Capture's navigation and actions over the saved folder mirror. */
import {
	CAPTURES_TABLE,
	type CaptureRow,
	captureBody,
	type captureTables,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import type { Saved, WriteError } from '@epicenter/folder/next';
import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { TextRange } from './capture-actions.svelte.js';

export type Captures = ReturnType<typeof createCaptures>;
export type CaptureFolder = SvelteFolder<typeof captureTables>;
export type Mode = 'capture' | 'text';
export type Focus = 'new-thought' | TextRange;
export type Opened = {
	readonly stem: string;
	readonly mode: Mode;
	readonly focus?: Focus;
};
export type TimelineRow = {
	readonly stem: string;
	readonly path: string;
	readonly capturedAt: Date | undefined;
	readonly preview: string;
	readonly thoughtCount: number;
};
export type Repair = {
	readonly stem: string;
	readonly path: string;
	readonly problem: string;
};
export type Deletion = {
	readonly stem: string;
	readonly path: string;
	readonly title: string;
	readonly draft: boolean;
};
export const CaptureError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});
export type CaptureError = InferErrors<typeof CaptureError>;
export type Failure = WriteError | CaptureError;
export const capturePath = (stem: string) => `${CAPTURES_TABLE}/${stem}.md`;

function newStem(at: Date): string {
	const stamp = at
		.toISOString()
		.slice(0, 19)
		.replace(/[-:]/g, '')
		.replace('T', '-');
	const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
		byte.toString(36).padStart(2, '0'),
	)
		.join('')
		.slice(0, 5);
	return `${stamp}-${suffix}`;
}

export function instantOf(value: unknown): Date | undefined {
	if (typeof value !== 'string') return undefined;
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

function newestFirst(left: TimelineRow, right: TimelineRow) {
	const a = left.capturedAt?.getTime();
	const b = right.capturedAt?.getTime();
	if (a !== b) {
		if (a === undefined) return 1;
		if (b === undefined) return -1;
		return b - a;
	}
	return left.stem < right.stem ? -1 : left.stem > right.stem ? 1 : 0;
}
function byPath(left: { path: string }, right: { path: string }) {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function readCaptureBody(
	row: Pick<Extract<CaptureRow, { issues: null }>, 'fields' | 'body'>,
) {
	const thoughts: string[] = [];
	if (row.fields.draft === true)
		return Ok({
			draft: true,
			text: row.body,
			thoughts,
			hasOtherContent: false,
		});
	const reading = captureBody.decode(row.body);
	if (reading.error !== null) return reading;
	return Ok({ ...reading.data, draft: false });
}

export function problemOf(row: Pick<CaptureRow, 'issues'>): string {
	return (row.issues ?? [])
		.map((issue) => {
			const at =
				'line' in issue && issue.line !== undefined
					? `Line ${issue.line}: `
					: '';
			const field =
				issue.kind === 'schema' && issue.path.length > 0
					? `${issue.path.join('.')} `
					: '';
			return `${at}${field}${issue.message.replace(/\.$/, '')}.`;
		})
		.join(' ');
}

export function timelineOf(listed: readonly CaptureRow[]) {
	const rows: TimelineRow[] = [];
	const drafts: TimelineRow[] = [];
	const repairs: Repair[] = [];
	const unreadable: { path: string; message: string; retry: boolean }[] = [];
	for (const row of listed) {
		const { id: stem, path } = row;
		if (
			row.issues?.some(
				(issue) => issue.kind === 'not-text' || issue.kind === 'unreadable',
			)
		) {
			unreadable.push({
				path,
				message: problemOf(row),
				retry: row.issues.some((issue) => issue.kind === 'unreadable'),
			});
			continue;
		}
		if (row.issues !== null) {
			repairs.push({ stem, path, problem: problemOf(row) });
			continue;
		}
		const { data: body, error } = readCaptureBody(row);
		if (error !== null) {
			repairs.push({ stem, path, problem: error.message });
			continue;
		}
		(body.draft ? drafts : rows).push({
			stem,
			path,
			capturedAt: instantOf(row.fields.capturedAt),
			preview: excerpt(body.text),
			thoughtCount: body.thoughts.length,
		});
	}
	return {
		rows: rows.sort(newestFirst),
		drafts: drafts.sort(newestFirst),
		repairs: repairs.sort(byPath),
		unreadable: unreadable.sort(byPath),
	};
}

export function createCaptures(folder: CaptureFolder) {
	let opened = $state.raw<Opened | undefined>();
	const ready: Saved = Promise.resolve(Ok(undefined));
	let last: Saved = ready;
	let navigation = 0;
	const timeline = $derived(timelineOf(folder.tables.captures.rows));

	function track(saved: Saved): Saved {
		last = saved;
		return saved;
	}
	async function settle(): Saved {
		folder.checkpoint();
		let seen = last;
		let result = await seen;
		while (seen !== last) {
			seen = last;
			result = await seen;
		}
		last = ready;
		return result;
	}
	async function own(saved: Saved) {
		track(saved);
		const result = await saved;
		if (last === saved) last = ready;
		return result;
	}
	async function go(
		requested: number,
		stem: string,
		mode: Mode,
		focus?: Focus,
	) {
		await settle();
		if (requested !== navigation) return;
		if (mode === 'capture') {
			const row = folder.tables.captures.row(stem);
			if (
				row === undefined ||
				row.issues !== null ||
				row.fields.draft === true ||
				readCaptureBody(row).error !== null
			) {
				mode = 'text';
				focus = undefined;
			}
		}
		if (focus !== undefined || opened?.stem !== stem || opened.mode !== mode)
			opened = { stem, mode, focus };
	}
	function open(stem: string, mode: Mode, focus?: Focus) {
		return go(++navigation, stem, mode, focus);
	}

	return {
		get timeline() {
			return timeline;
		},
		get saveLabel(): 'Saved' | 'Saving…' {
			return folder.saving ? 'Saving…' : 'Saved';
		},
		get opened() {
			return opened;
		},
		track,
		settle,
		open,
		leave() {
			++navigation;
			opened = undefined;
		},
		async create(text: string): Promise<Result<{ stem: string }, Failure>> {
			if (text.trim() === '')
				return CaptureError.Refused({ message: 'Write something first.' });
			const requested = ++navigation;
			const now = new Date();
			const stem = newStem(now);
			const saved = await own(
				folder.tables.captures.create(stem, {
					fields: { capturedAt: now.toISOString() },
					body: composeBody(text.toWellFormed()).body,
				}),
			);
			if (saved.error !== null) return saved;
			await go(requested, stem, 'capture', 'new-thought');
			return Ok({ stem });
		},
		async finishDraft(stem: string): Promise<Result<void, Failure>> {
			const requested = ++navigation;
			const settled = await settle();
			if (settled.error !== null)
				return CaptureError.Refused({
					message: 'Your last edit did not save; nothing was added.',
				});
			const row = folder.tables.captures.row(stem);
			if (row === undefined)
				return CaptureError.Refused({
					message: 'This draft is no longer here.',
				});
			if (row.issues !== null)
				return CaptureError.Refused({
					message: 'Repair this file as text before adding it.',
				});
			if (row.fields.draft !== true) {
				await go(requested, stem, 'capture', 'new-thought');
				return Ok(undefined);
			}
			if (row.body.trim() === '')
				return CaptureError.Refused({ message: 'Write something first.' });
			const saved = await own(
				folder.tables.captures.update(stem, {
					fields: { draft: undefined, capturedAt: new Date().toISOString() },
					body: composeBody(row.body).body,
				}),
			);
			if (saved.error !== null) return saved;
			await go(requested, stem, 'capture', 'new-thought');
			return Ok(undefined);
		},
		deletionFor(stem: string): Deletion {
			const row = folder.tables.captures.row(stem);
			const reading =
				row?.issues === null ? readCaptureBody(row).data : undefined;
			return {
				stem,
				path: capturePath(stem),
				title: reading?.text.trim().slice(0, 60) ?? '',
				draft: reading?.draft ?? false,
			};
		},
		async delete(deletion: Deletion): Promise<Result<void, WriteError>> {
			const deleted = await own(folder.tables.captures.delete(deletion.stem));
			if (deleted.error === null && opened?.stem === deletion.stem) {
				++navigation;
				opened = undefined;
			}
			return deleted;
		},
	};
}
