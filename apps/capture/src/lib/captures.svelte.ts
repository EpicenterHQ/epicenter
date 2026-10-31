/** Capture's navigation and actions over the saved folder mirror. */
import {
	CAPTURES_TABLE,
	type CaptureRow,
	captureBody,
	type captureTables,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import { describeIssues, type WriteError } from '@epicenter/folder';
import type { SvelteFolder } from '@epicenter/svelte/folder';
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
	return captureBody.decode(row.body);
}

export function timelineOf(listed: readonly CaptureRow[]) {
	const rows: TimelineRow[] = [];
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
				message: describeIssues(row.issues),
				retry: row.issues.some((issue) => issue.kind === 'unreadable'),
			});
			continue;
		}
		if (row.issues !== null) {
			repairs.push({ stem, path, problem: describeIssues(row.issues) });
			continue;
		}
		const { data: body, error } = readCaptureBody(row);
		if (error !== null) {
			repairs.push({ stem, path, problem: error.message });
			continue;
		}
		rows.push({
			stem,
			path,
			capturedAt: instantOf(row.fields.capturedAt),
			preview: excerpt(body.text),
			thoughtCount: body.thoughts.length,
		});
	}
	return {
		rows: rows.sort(newestFirst),
		repairs: repairs.sort(byPath),
		unreadable: unreadable.sort(byPath),
	};
}

export function createCaptures(folder: CaptureFolder) {
	let opened = $state.raw<Opened | undefined>();
	let navigation = 0;
	const timeline = $derived(timelineOf(folder.tables.captures.rows));
	function go(requested: number, stem: string, mode: Mode, focus?: Focus) {
		if (requested !== navigation) return;
		if (mode === 'capture') {
			const row = folder.tables.captures.row(stem);
			if (
				row === undefined ||
				row.issues !== null ||
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
		get opened() {
			return opened;
		},
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
			const saved = await folder.tables.captures.create(stem, {
				fields: { capturedAt: now.toISOString() },
				body: composeBody(text).body,
			});
			if (saved.error !== null) return saved;
			go(requested, stem, 'capture', 'new-thought');
			return Ok({ stem });
		},
		deletionFor(stem: string): Deletion {
			const row = folder.tables.captures.row(stem);
			const reading =
				row?.issues === null ? readCaptureBody(row).data : undefined;
			return {
				stem,
				path: capturePath(stem),
				title: reading?.text.trim().slice(0, 60) ?? '',
			};
		},
		async delete(deletion: Deletion): Promise<Result<void, WriteError>> {
			const deleted = await folder.tables.captures.delete(deletion.stem);
			if (deleted.error === null && opened?.stem === deletion.stem) {
				++navigation;
				opened = undefined;
			}
			return deleted;
		},
	};
}
