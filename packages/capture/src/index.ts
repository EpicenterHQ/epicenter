import {
	defineStore,
	defineTable,
	field,
	plainText,
	type RowOf,
} from '@epicenter/app';
import { InstantString } from '@epicenter/app/field';
import type { Data, DeclaredData } from '@epicenter/app/store';
import * as Y from '@y/y';

const captures = defineTable({
	fields: { capturedAt: field.instant() },
	body: plainText(),
});
const thoughts = defineTable({
	fields: {
		captureId: field.reference('captures'),
		position: field.integer(),
	},
	body: plainText(),
});
// A promotion key stays even if its capture is later deleted. Replayed requests
// must never create a second root capture.
const promotions = defineTable({
	fields: {
		requestId: field.string(),
		captureId: field.nullable(field.reference('captures')),
	},
});
// Earlier rows remain declared so retained account data can be read and copied.
const entries = defineTable({
	fields: {
		parentId: field.nullable(field.string()),
		capturedAt: field.instant(),
	},
	body: plainText(),
});

export const captureDefinition = defineStore({
	id: 'so.epicenter.capture',
	title: 'Capture',
	kv: {},
	tables: { captures, thoughts, entries, promotions },
});
export type CaptureData = DeclaredData<typeof captureDefinition>;
export type Capture = RowOf<typeof captures>;
export type Thought = RowOf<typeof thoughts>;

export const CAPTURE_PROMOTION_CHANNEL = 'epicenter.capture.promotion.v1';
export type CapturePromotionRequest = {
	type: 'add';
	requestId: string;
	account: { authorityId: string; principalId: string };
	text: string;
	capturedAt: ReturnType<typeof InstantString.now>;
};
export type CapturePromotionAcknowledgement = {
	type: 'added';
	requestId: string;
	account: CapturePromotionRequest['account'];
	captureId: string;
};
export type CapturePromotionOpen = {
	type: 'open';
	requestId: string;
	account: CapturePromotionRequest['account'];
	captureId: string;
};
export type CapturePromotionOpened = {
	type: 'opened';
	requestId: string;
	account: CapturePromotionRequest['account'];
	captureId: string;
};
export type CapturePromotionProblem = {
	type: 'inspection-required' | 'unavailable';
	requestId: string;
	account: CapturePromotionRequest['account'];
	captureId: string | null;
};
export type CapturePromotionMessage =
	| CapturePromotionRequest
	| CapturePromotionAcknowledgement
	| CapturePromotionOpen
	| CapturePromotionOpened
	| CapturePromotionProblem;

export class PromotionInspectionRequired extends Error {
	constructor() {
		super('Capture may have accepted this request. Inspect Capture before creating another.');
		this.name = 'PromotionInspectionRequired';
	}
}

function bodyFrom(text: string): Y.Node {
	const body = new Y.Node();
	if (text) body.applyDelta(body.change.insert(text) as never);
	return body;
}

export function createCapture(
	data: CaptureData,
	text: string,
	capturedAt = InstantString.now(),
): Capture {
	return data.tables.captures.create({ capturedAt }, bodyFrom(text));
}

/** Idempotent creation for a request accepted by the owning Capture document. */
export function createPromotedCapture(
	data: CaptureData & Pick<Data<typeof captureDefinition>, 'transact'>,
	request: { requestId: string; text: string; capturedAt: ReturnType<typeof InstantString.now> },
): string {
	const existing = data.tables.promotions.rows.find((row) => row.requestId === request.requestId);
	if (existing) {
		if (!existing.captureId)
			throw new PromotionInspectionRequired();
		return existing.captureId;
	}
	let captureId = '';
	data.transact(() => {
		// Transactions do not roll back on throws. Claim the key before creation,
		// so a partial acceptance can never be replayed into a second root.
		const marker = data.tables.promotions.create({ requestId: request.requestId, captureId: null });
		captureId = createCapture(data, request.text, request.capturedAt).id;
		const written = data.tables.promotions.update(marker.id, { captureId });
		if (written.error) throw written.error;
	});
	return captureId;
}

export function captureView(data: CaptureData) {
	const captures = [...data.tables.captures.rows].sort((a, b) =>
		a.capturedAt === b.capturedAt
			? a.id < b.id
				? -1
				: a.id > b.id
					? 1
					: 0
			: a.capturedAt > b.capturedAt
				? -1
				: 1,
	);
	const byId = new Map(captures.map((capture) => [capture.id, capture]));
	const thoughts = new Map<string, Thought[]>();
	const recovery: Thought[] = [];
	for (const thought of data.tables.thoughts.rows) {
		const group = byId.has(thought.captureId)
			? (thoughts.get(thought.captureId) ?? [])
			: recovery;
		group.push(thought);
		if (group !== recovery) thoughts.set(thought.captureId, group);
	}
	const compare = (a: Thought, b: Thought) =>
		a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	for (const group of thoughts.values()) group.sort(compare);
	recovery.sort(compare);
	return { captures, byId, thoughts, recovery };
}

function nextPosition(data: CaptureData, captureId: string): number {
	let next = 0;
	for (const row of captureView(data).thoughts.get(captureId) ?? [])
		next = Math.max(next, row.position + 1);
	return next;
}

export function createThought(
	data: CaptureData,
	captureId: string,
	text: string,
): Thought {
	if (!data.tables.captures.get(captureId))
		throw new Error('The capture is no longer available.');
	return data.tables.thoughts.create(
		{ captureId, position: nextPosition(data, captureId) },
		bodyFrom(text),
	);
}

export function moveThought(
	data: CaptureData,
	id: string,
	captureId: string,
): void {
	const thought = data.tables.thoughts.get(id);
	if (!thought) throw new Error('The thought is no longer available.');
	if (!data.tables.captures.get(captureId))
		throw new Error('The destination capture is unavailable.');
	if (thought.captureId === captureId) return;
	data.tables.thoughts.update(id, {
		captureId,
		position: nextPosition(data, captureId),
	});
}

/** Concurrent position writes can mix; the ID tie-breaker keeps every row visible. */
export function reorderThought(
	data: CaptureData,
	id: string,
	direction: -1 | 1,
): void {
	const thought = data.tables.thoughts.get(id);
	if (!thought) throw new Error('The thought is no longer available.');
	const group = captureView(data).thoughts.get(thought.captureId) ?? [];
	const index = group.findIndex((row) => row.id === id);
	const target = index + direction;
	if (target < 0 || target >= group.length) return;
	const ordered = [...group];
	const current = ordered[index];
	const other = ordered[target];
	if (!current || !other) return;
	ordered[index] = other;
	ordered[target] = current;
	data.transact(() => {
		ordered.forEach((row, position) => {
			data.tables.thoughts.update(row.id, { position });
		});
	});
}

export function previewCaptureDeletion(data: CaptureData, id: string) {
	if (!data.tables.captures.get(id))
		throw new Error('The capture is no longer available.');
	for (const row of data.tables.thoughts.nonconforming) {
		const parent = row.raw.captureId;
		if (typeof parent !== 'string' || parent === id)
			throw new Error('Unreadable thoughts could belong to this capture.');
	}
	return {
		captureId: id,
		text: data.tables.captures.body(id)?.toString() ?? '',
		thoughts: (captureView(data).thoughts.get(id) ?? []).map((thought) => ({
			id: thought.id,
			text: data.tables.thoughts.body(thought.id)?.toString() ?? '',
		})),
	};
}

export async function deleteConfirmedCapture(
	data: CaptureData & Pick<Data<typeof captureDefinition>, 'persistence'>,
	preview: ReturnType<typeof previewCaptureDeletion>,
): Promise<void> {
	if (data.tables.captures.get(preview.captureId)) {
		if (
			JSON.stringify(previewCaptureDeletion(data, preview.captureId)) !==
			JSON.stringify(preview)
		)
			throw new Error('This capture changed. Review it again before deleting.');
	} else {
		for (const thought of preview.thoughts) {
			if (
				data.tables.thoughts.get(thought.id) &&
				data.tables.thoughts.body(thought.id)?.toString() !== thought.text
			)
				throw new Error(
					'This thought changed. Review it again before deleting.',
				);
		}
	}
	data.transact(() => {
		for (const thought of preview.thoughts)
			data.tables.thoughts.delete(thought.id);
		data.tables.captures.delete(preview.captureId);
	});
	await data.persistence.flush();
	if (data.persistence.get() !== 'saved')
		throw new Error(
			'Deletion is pending because local storage could not save it.',
		);
}

export async function deleteConfirmedThought(
	data: CaptureData & Pick<Data<typeof captureDefinition>, 'persistence'>,
	id: string,
	text: string,
): Promise<void> {
	if (
		data.tables.thoughts.get(id) &&
		data.tables.thoughts.body(id)?.toString() !== text
	)
		throw new Error('This thought changed. Review it again before deleting.');
	data.tables.thoughts.delete(id);
	await data.persistence.flush();
	if (data.persistence.get() !== 'saved')
		throw new Error(
			'Deletion is pending because local storage could not save it.',
		);
}
