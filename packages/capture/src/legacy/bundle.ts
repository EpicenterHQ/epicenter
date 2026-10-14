/**
 * The export bundle: one bounded, immutable snapshot of an account's old
 * Capture rows as this device held them.
 *
 * - Bounded: it is what one device's replica contained at `exportedAt`. A
 *   replica that has not finished syncing holds less than the account does,
 *   and the bundle cannot tell. `source.scope` says so in the data.
 * - Immutable: an import reads a bundle, never the store. A retry reuses the
 *   same bundle, so it plans the same documents. Exporting again later makes
 *   a different bundle with a different ID.
 * - Complete about what it could not read: a row whose values do not conform
 *   is carried in `unreadable` with its raw stored values, and a row whose
 *   body could not be read has `text: null`, which is distinct from an empty
 *   body's `text: ''`.
 *
 * Exporting only reads. The store is never written.
 */

export const BUNDLE_FORMAT = 'epicenter.capture.legacy-bundle';

export type LegacyAccount = {
	readonly authorityId: string;
	readonly principalId: string;
};

export type LegacyCapture = {
	readonly id: string;
	readonly capturedAt: string;
	/** `null` when the body could not be read; `''` when it was empty. */
	readonly text: string | null;
};

export type LegacyThought = {
	readonly id: string;
	readonly captureId: string;
	readonly position: number;
	readonly text: string | null;
};

export type LegacyEntry = {
	readonly id: string;
	readonly parentId: string | null;
	readonly capturedAt: string;
	readonly text: string | null;
};

export type LegacyTableName = 'captures' | 'thoughts' | 'entries';

/** A row whose stored values this release cannot read as its table's fields. */
export type LegacyUnreadableRow = {
	readonly table: LegacyTableName;
	readonly id: string;
	/** The stored values, unmodified. */
	readonly raw: unknown;
	readonly issues: readonly string[];
	/** The row's body text when it could still be read. */
	readonly text: string | null;
};

export type LegacyBundle = {
	readonly format: typeof BUNDLE_FORMAT;
	readonly version: 1;
	readonly exportedAt: string;
	readonly source: {
		readonly storeId: string;
		readonly account: LegacyAccount;
		/** One device's local replica, not a statement about the whole account. */
		readonly scope: 'local-replica';
	};
	readonly captures: readonly LegacyCapture[];
	readonly thoughts: readonly LegacyThought[];
	readonly entries: readonly LegacyEntry[];
	readonly unreadable: readonly LegacyUnreadableRow[];
	/** Handoff bookkeeping rows that held no writing and are not exported. */
	readonly promotionCount: number;
};

const byId = <T extends { id: string }>(left: T, right: T) =>
	left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

// ============================================================================
// Reading a bundle back
// ============================================================================

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string | null =>
	value === null || typeof value === 'string';

const isInstant = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^\d{4}-\d{2}-\d{2}T/.test(value) &&
	!Number.isNaN(Date.parse(value));

/**
 * Check that a parsed JSON value is a bundle this release can import. A file
 * that is not one is refused whole, with every problem named, rather than
 * imported in part.
 */
export function readLegacyBundle(
	value: unknown,
):
	| { readonly ok: true; readonly bundle: LegacyBundle }
	| { readonly ok: false; readonly problems: readonly string[] } {
	const problems: string[] = [];
	if (!isRecord(value)) return { ok: false, problems: ['Not a JSON object.'] };
	if (value.format !== BUNDLE_FORMAT)
		problems.push(`"format" is not "${BUNDLE_FORMAT}".`);
	if (value.version !== 1) problems.push('"version" is not 1.');
	if (!isInstant(value.exportedAt))
		problems.push('"exportedAt" is not a date and time.');
	const source = isRecord(value.source) ? value.source : undefined;
	const account = isRecord(source?.account) ? source.account : undefined;
	if (
		typeof account?.authorityId !== 'string' ||
		account.authorityId === '' ||
		typeof account.principalId !== 'string' ||
		account.principalId === ''
	)
		problems.push('"source.account" needs an authorityId and a principalId.');

	function list<T>(
		key: string,
		check: (item: Record<string, unknown>) => string | undefined,
	): T[] {
		const items = (value as Record<string, unknown>)[key];
		if (!Array.isArray(items)) {
			problems.push(`"${key}" is not a list.`);
			return [];
		}
		const seen = new Set<string>();
		items.forEach((item, index) => {
			if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') {
				problems.push(`${key}[${index}] has no id.`);
				return;
			}
			const tag = `${typeof item.table === 'string' ? item.table : ''}/${item.id}`;
			if (seen.has(tag))
				problems.push(`${key}[${index}] repeats id ${item.id}.`);
			seen.add(tag);
			const problem = check(item);
			if (problem !== undefined) problems.push(`${key}[${index}] ${problem}`);
		});
		return items as T[];
	}

	const captures = list<LegacyCapture>('captures', (item) =>
		!isInstant(item.capturedAt)
			? 'has no capturedAt date and time.'
			: !isText(item.text)
				? 'has a text that is neither a string nor null.'
				: undefined,
	);
	const thoughts = list<LegacyThought>('thoughts', (item) =>
		typeof item.captureId !== 'string'
			? 'has no captureId.'
			: typeof item.position !== 'number' || !Number.isFinite(item.position)
				? 'has no numeric position.'
				: !isText(item.text)
					? 'has a text that is neither a string nor null.'
					: undefined,
	);
	const entries = list<LegacyEntry>('entries', (item) =>
		!isInstant(item.capturedAt)
			? 'has no capturedAt date and time.'
			: item.parentId !== null && typeof item.parentId !== 'string'
				? 'has a parentId that is neither a string nor null.'
				: !isText(item.text)
					? 'has a text that is neither a string nor null.'
					: undefined,
	);
	const unreadable = list<LegacyUnreadableRow>('unreadable', (item) =>
		item.table !== 'captures' &&
		item.table !== 'thoughts' &&
		item.table !== 'entries'
			? 'names no table.'
			: !Array.isArray(item.issues) ||
					!item.issues.every((issue) => typeof issue === 'string')
				? 'has no list of issues.'
				: !isText(item.text)
					? 'has a text that is neither a string nor null.'
					: undefined,
	);
	const promotionCount = value.promotionCount;
	if (
		typeof promotionCount !== 'number' ||
		!Number.isInteger(promotionCount) ||
		promotionCount < 0
	)
		problems.push('"promotionCount" is not a whole number.');
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		bundle: {
			format: BUNDLE_FORMAT,
			version: 1,
			exportedAt: value.exportedAt as string,
			source: {
				storeId: String(source?.storeId ?? 'so.epicenter.capture'),
				account: {
					authorityId: account?.authorityId as string,
					principalId: account?.principalId as string,
				},
				scope: 'local-replica',
			},
			captures: [...captures].sort(byId),
			thoughts: [...thoughts].sort(byId),
			entries: [...entries].sort(byId),
			unreadable: [...unreadable].sort(
				(left, right) =>
					left.table.localeCompare(right.table) || byId(left, right),
			),
			promotionCount: promotionCount as number,
		},
	};
}

/** The bundle's bytes as saved: stable key order and indentation. */
export function serializeLegacyBundle(bundle: LegacyBundle): string {
	return `${JSON.stringify(
		{
			format: bundle.format,
			version: bundle.version,
			exportedAt: bundle.exportedAt,
			source: {
				storeId: bundle.source.storeId,
				account: {
					authorityId: bundle.source.account.authorityId,
					principalId: bundle.source.account.principalId,
				},
				scope: bundle.source.scope,
			},
			promotionCount: bundle.promotionCount,
			captures: bundle.captures.map(({ id, capturedAt, text }) => ({
				id,
				capturedAt,
				text,
			})),
			thoughts: bundle.thoughts.map(({ id, captureId, position, text }) => ({
				id,
				captureId,
				position,
				text,
			})),
			entries: bundle.entries.map(({ id, parentId, capturedAt, text }) => ({
				id,
				parentId,
				capturedAt,
				text,
			})),
			unreadable: bundle.unreadable.map(({ table, id, raw, issues, text }) => ({
				table,
				id,
				raw,
				issues,
				text,
			})),
		},
		null,
		'\t',
	)}\n`;
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	let hex = '';
	for (const byte of new Uint8Array(digest))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}

/** The identity of a bundle's content. Two exports with the same rows and time share it. */
export async function bundleIdOf(bundle: LegacyBundle): Promise<string> {
	return (await sha256Hex(serializeLegacyBundle(bundle))).slice(0, 16);
}

/** A short, stable tag for an account, used to scope imported file names. */
export async function accountTagOf(account: LegacyAccount): Promise<string> {
	return (
		await sha256Hex(`${account.authorityId}\n${account.principalId}`)
	).slice(0, 8);
}
