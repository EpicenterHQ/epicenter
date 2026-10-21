/** Saved views project saved documents; unfinished field drafts never move rows. */
import type {
	PortableTableSchema,
	SavedView,
} from '@epicenter/folder/declaration';
import type { Document } from '@epicenter/folder/documents';

type TableView = Extract<SavedView, { type: 'grid' | 'board' }>;
type Filter = NonNullable<TableView['filters']>[number];
type Scalar = string | number | boolean | null;

/** Apply only saved fields. Membership in the selected table belongs to the caller. */
export function applyView(documents: readonly Document[], view: TableView) {
	const filters = view.filters ?? [];
	const problems = filters.flatMap((filter, index) => {
		const problem = filterProblem(filter);
		return problem === undefined
			? []
			: [`Filter ${index + 1} (${filter.field}): ${problem}`];
	});
	if (problems.length > 0) return { documents: [] as Document[], problems };
	const selected = documents.filter((document) =>
		filters.every((filter) => matches(fieldOf(document, filter.field), filter)),
	);
	selected.sort((left, right) => {
		for (const sort of view.sort ?? []) {
			const a = fieldOf(left, sort.field);
			const b = fieldOf(right, sort.field);
			// Missing stays last in either direction, including after equal fields.
			if (a === undefined || b === undefined) {
				if (a !== b) return a === undefined ? 1 : -1;
				continue;
			}
			const compared = compareValues(a, b);
			if (compared !== 0)
				return sort.direction === 'desc' ? -compared : compared;
		}
		return compareText(left.path, right.path);
	});
	return { documents: selected, problems };
}

/** One typed destination for grouping saved scalar values. */
export type BoardLane = {
	key: string;
	label: string;
	value: Scalar | undefined;
	documents: Document[];
	editable: boolean;
};

/** Hint lanes stay visible when empty; missing is an explicit clear-field destination. */
export function boardLanes(
	documents: readonly Document[],
	field: string,
	schema?: PortableTableSchema,
): BoardLane[] {
	const lanes = new Map<string, BoardLane>();
	const hinted: BoardLane[] = [];
	for (const value of hintedValues(schema?.properties[field])) {
		const key = scalarKey(value);
		if (lanes.has(key)) continue;
		const lane = {
			key,
			label: scalarLabel(value),
			value,
			documents: [],
			editable: true,
		};
		lanes.set(key, lane);
		hinted.push(lane);
	}
	const observed: BoardLane[] = [];
	const missing: BoardLane = {
		key: 'missing',
		label: 'No value',
		value: undefined,
		documents: [],
		editable: true,
	};
	const other: BoardLane = {
		key: 'other',
		label: 'Other',
		value: undefined,
		documents: [],
		editable: false,
	};
	for (const document of documents) {
		const value = fieldOf(document, field);
		if (value === undefined) {
			missing.documents.push(document);
			continue;
		}
		if (!isScalar(value)) {
			other.documents.push(document);
			continue;
		}
		const key = scalarKey(value);
		let lane = lanes.get(key);
		if (lane === undefined) {
			lane = {
				key,
				label: scalarLabel(value),
				value,
				documents: [],
				editable: true,
			};
			lanes.set(key, lane);
			observed.push(lane);
		}
		lane.documents.push(document);
	}
	observed.sort((a, b) => compareValues(a.value, b.value));
	const result = [
		...hinted,
		...observed,
		missing,
		...(other.documents.length > 0 ? [other] : []),
	];
	const labels = new Map<string, number>();
	for (const lane of result)
		labels.set(lane.label, (labels.get(lane.label) ?? 0) + 1);
	const assigned = new Set<string>();
	for (const lane of result) {
		if ((labels.get(lane.label) ?? 0) < 2) {
			assigned.add(lane.label);
			continue;
		}
		const kind =
			lane.key === 'missing'
				? 'missing'
				: lane.key === 'other'
					? 'other values'
					: lane.value === null
						? 'null'
						: typeof lane.value === 'string'
							? 'text'
							: typeof lane.value;
		lane.label = `${lane.label} (${kind})`;
		while (labels.has(lane.label) || assigned.has(lane.label))
			lane.label = `${lane.label} (${kind})`;
		assigned.add(lane.label);
	}
	return result;
}

function fieldOf(document: Document, field: string): unknown {
	return document.fields !== undefined && Object.hasOwn(document.fields, field)
		? document.fields[field]
		: undefined;
}

function filterProblem(filter: Filter): string | undefined {
	if (filter.field.trim() === '') return 'Choose a field';
	if (filter.operator === 'exists')
		return filter.value === undefined || typeof filter.value === 'boolean'
			? undefined
			: 'exists expects true or false';
	if (filter.value === undefined) return `${filter.operator} needs a value`;
	if (['lt', 'lte', 'gt', 'gte'].includes(filter.operator))
		return typeof filter.value === 'string' ||
			(typeof filter.value === 'number' && Number.isFinite(filter.value))
			? undefined
			: `${filter.operator} expects text or a number`;
	return undefined;
}

function matches(value: unknown, filter: Filter): boolean {
	switch (filter.operator) {
		case 'exists':
			return (value !== undefined) === (filter.value ?? true);
		case 'eq':
			return value !== undefined && equalJson(value, filter.value);
		case 'ne':
			return value === undefined || !equalJson(value, filter.value);
		case 'contains':
			return typeof value === 'string' && typeof filter.value === 'string'
				? value.includes(filter.value)
				: Array.isArray(value) &&
						value.some((item) => equalJson(item, filter.value));
		case 'lt':
		case 'lte':
		case 'gt':
		case 'gte': {
			const expected = filter.value;
			if (
				!(
					(typeof value === 'string' && typeof expected === 'string') ||
					(typeof value === 'number' &&
						Number.isFinite(value) &&
						typeof expected === 'number')
				)
			)
				return false;
			const compared = compareValues(value, expected);
			switch (filter.operator) {
				case 'lt':
					return compared < 0;
				case 'lte':
					return compared <= 0;
				case 'gt':
					return compared > 0;
				case 'gte':
					return compared >= 0;
			}
		}
	}
}

function equalJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (
		typeof left !== 'object' ||
		left === null ||
		typeof right !== 'object' ||
		right === null
	)
		return false;
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => equalJson(value, right[index]))
		);
	const entries = Object.entries(left);
	return (
		entries.length === Object.keys(right).length &&
		entries.every(
			([key, value]) =>
				Object.hasOwn(right, key) &&
				equalJson(value, (right as Record<string, unknown>)[key]),
		)
	);
}

function isScalar(value: unknown): value is Scalar {
	return (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	);
}

const scalarKey = (value: Scalar) =>
	`${value === null ? 'null' : typeof value}:${JSON.stringify(value)}`;
const scalarLabel = (value: Scalar) =>
	typeof value === 'string' ? value : String(value);
const compareText = (left: string, right: string) =>
	left < right ? -1 : left > right ? 1 : 0;

function compareValues(left: unknown, right: unknown): number {
	const rank = (value: unknown) =>
		value === null
			? 0
			: typeof value === 'boolean'
				? 1
				: typeof value === 'number' && Number.isFinite(value)
					? 2
					: typeof value === 'string'
						? 3
						: Array.isArray(value)
							? 4
							: value === undefined
								? 6
								: 5;
	const order = rank(left) - rank(right);
	if (order !== 0) return order;
	if (typeof left === 'number' && typeof right === 'number')
		return left < right ? -1 : left > right ? 1 : 0;
	if (typeof left === 'boolean' && typeof right === 'boolean')
		return Number(left) - Number(right);
	if (typeof left === 'string' && typeof right === 'string')
		return compareText(left, right);
	return compareText(stableJson(left), stableJson(right));
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (typeof value === 'object' && value !== null)
		return `{${Object.keys(value)
			.sort(compareText)
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
			)
			.join(',')}}`;
	return JSON.stringify(value) ?? String(value);
}

function hintedValues(value: unknown): Scalar[] {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return [];
	const schema = value as Record<string, unknown>;
	if (Array.isArray(schema.enum)) return schema.enum.filter(isScalar);
	if (Object.hasOwn(schema, 'const'))
		return isScalar(schema.const) ? [schema.const] : [];
	if (Array.isArray(schema.anyOf)) return schema.anyOf.flatMap(hintedValues);
	if (schema.type === 'boolean') return [false, true];
	if (schema.type === 'null') return [null];
	return [];
}
