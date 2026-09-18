import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { GmailClient, GmailClientError } from './gmail-client.ts';
import type { FullPullCheckpoint, Mailbox } from './mailbox.ts';
import type { GmailMessage, HistoryRecord } from './schema.ts';

const FULL_PULL_GET_CHUNK_SIZE = 8;

export type SyncMode = 'FULL' | 'INCREMENTAL';

/**
 * A concurrent writer held the cache's lock past the busy timeout. The failed
 * batch rolled back whole, so the cursor did not advance and the next pass
 * retries the same window. It is a reportable outcome rather than a crash,
 * because the cache is one file that a pass writes and the page reads, and a
 * write that loses the lock costs one pass rather than the surface.
 */
export const CacheWriteError = defineErrors({
	CacheBusy: ({ cause }: { cause: unknown }) => ({
		message: `The mail cache is locked by another writer (${extractErrorMessage(cause)}). Nothing was lost; the next sync pass retries.`,
		cause,
	}),
});
export type CacheWriteError = InferErrors<typeof CacheWriteError>;

export type SyncFailure = GmailClientError | CacheWriteError;

function isSqliteBusy(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

export type SyncOutcome = {
	mode: SyncMode;
	reason: string;
	cursorBefore: string | null;
	cursorAfter: string | null;
	messagesUpserted: number;
	messagesDeleted: number;
	/** Mirrored rows whose label set materially changed this pass. An idempotent
	 * history echo of labels the reconciler already folded counts 0, so
	 * this reads as "what the sync actually changed", like its sibling counts. */
	labelsPatched: number;
	failure: SyncFailure | null;
};

export type SyncDeps = {
	mailbox: Mailbox;
	client: GmailClient;
	now: () => number;
	log?: (message: string) => void;
};

/** Failure before a checkpoint; completed download pages remain readable. */
function failedOutcome(
	mode: SyncMode,
	reason: string,
	cursorBefore: string | null,
	failure: SyncFailure,
	messagesUpserted = 0,
): SyncOutcome {
	return {
		mode,
		reason,
		cursorBefore,
		cursorAfter: cursorBefore,
		messagesUpserted,
		messagesDeleted: 0,
		labelsPatched: 0,
		failure,
	};
}

/** Download all messages, committing each complete page for offline reading. */
async function fullPull(
	deps: SyncDeps,
	checkpoint: FullPullCheckpoint,
	resuming: boolean,
): Promise<{
	upserted: number;
	failure: SyncFailure | null;
	rejectedPageToken?: true;
}> {
	const { mailbox, client } = deps;
	const log = deps.log ?? (() => {});
	let upserted = 0;
	let pageToken = checkpoint.nextPageToken ?? undefined;
	let page = 0;
	if (resuming && pageToken === undefined) return { upserted, failure: null };

	const labels = await client.listLabels();
	if (labels.error) return { upserted, failure: labels.error };
	await mailbox.ingestLabels(labels.data);

	while (true) {
		page += 1;
		const listed = await client.listMessageIds(pageToken);
		if (listed.error) {
			// A bad request with a continuation may be a stale page token. Restart
			// once at the caller; a first-page failure is never swallowed.
			return {
				upserted,
				failure: listed.error,
				...(pageToken &&
				listed.error.name === 'Http' &&
				listed.error.status === 400
					? { rejectedPageToken: true as const }
					: {}),
			};
		}

		const messages: GmailMessage[] = [];
		for (
			let start = 0;
			start < listed.data.ids.length;
			start += FULL_PULL_GET_CHUNK_SIZE
		) {
			const chunk = listed.data.ids.slice(
				start,
				start + FULL_PULL_GET_CHUNK_SIZE,
			);
			const fetched = await Promise.all(
				chunk.map((id) => client.getMessage(id)),
			);
			for (const result of fetched) {
				if (result.error) {
					if (result.error.name === 'Http' && result.error.status === 404)
						continue;
					return { upserted, failure: result.error };
				}
				messages.push(result.data);
			}
		}

		try {
			await mailbox.ingestFullPullPage(messages, {
				...checkpoint,
				nextPageToken: listed.data.nextPageToken ?? null,
			});
		} catch (cause) {
			if (!isSqliteBusy(cause)) throw cause;
			return { upserted, failure: CacheWriteError.CacheBusy({ cause }).error };
		}
		upserted += messages.length;
		log(
			`full pull: page ${page}, ${messages.length} messages (${upserted} total)`,
		);

		if (!listed.data.nextPageToken) break;
		pageToken = listed.data.nextPageToken;
	}

	return { upserted, failure: null };
}

/** Per-message final action after folding every history record for it, in order. */
type PendingAction =
	| { kind: 'upsert' }
	| { kind: 'delete' }
	| { kind: 'labelPatch'; wants: Map<string, boolean> };

/**
 * Fold every history record across every page into one final action per
 * message id. A message touched by multiple records in the same batch (e.g.
 * added then re-labeled) resolves to its LAST state: an `upsert` always wins
 * over a later `labelPatch` for the same id (the full re-fetch already carries
 * current labels, so a separate patch would be redundant), and a `delete`
 * always wins over anything before it (a `labelsAdded` after a permanent
 * delete cannot happen and is ignored defensively).
 */
function foldHistoryRecords(
	records: HistoryRecord[],
): Map<string, PendingAction> {
	const actions = new Map<string, PendingAction>();
	for (const record of records) {
		for (const { message } of record.messagesAdded ?? []) {
			actions.set(message.id, { kind: 'upsert' });
		}
		for (const { message } of record.messagesDeleted ?? []) {
			actions.set(message.id, { kind: 'delete' });
		}
		for (const [events, want] of [
			[record.labelsAdded ?? [], true],
			[record.labelsRemoved ?? [], false],
		] as const) {
			for (const { message, labelIds } of events) {
				const existing = actions.get(message.id);
				if (existing?.kind === 'upsert' || existing?.kind === 'delete')
					continue;
				const wants = existing?.wants ?? new Map<string, boolean>();
				for (const labelId of labelIds) wants.set(labelId, want);
				actions.set(message.id, { kind: 'labelPatch', wants });
			}
		}
	}
	return actions;
}

/**
 * Incremental refresh: paginate `history.list` from `cursorBefore`, fold every
 * record into a final per-message action, fetch full content for anything
 * that needs it, then apply the whole batch and advance the cursor in one
 * batch (`mailbox.applyHistoryBatch`). A `messages.get` 404 for a message
 * flagged `upsert` (added, then permanently deleted before we fetched it) is
 * folded into a delete rather than failing the pass. Any other failure aborts
 * without advancing the cursor, so the next pass re-pulls the same window.
 */
async function incrementalPoll(
	deps: SyncDeps,
	cursorBefore: string,
	syncedAt: string,
): Promise<SyncOutcome> {
	const { mailbox, client } = deps;
	const log = deps.log ?? (() => {});
	const records: HistoryRecord[] = [];
	let newHistoryId = cursorBefore;
	let pageToken: string | undefined;

	while (true) {
		const page = await client.listHistory(cursorBefore, pageToken);
		if (page.error) {
			const reason =
				page.error.name === 'HistoryExpired'
					? 'historyId expired (404); caller should retry as FULL'
					: 'history.list failed';
			return failedOutcome('INCREMENTAL', reason, cursorBefore, page.error);
		}
		newHistoryId = page.data.historyId;
		// A no-change response has no `history` key at all (not `.length === 0`).
		if (page.data.history) records.push(...page.data.history);
		if (!page.data.nextPageToken) break;
		pageToken = page.data.nextPageToken;
	}

	const actions = foldHistoryRecords(records);
	const messagesToUpsert: GmailMessage[] = [];
	const messagesToDelete: string[] = [];
	const labelPatches: {
		messageId: string;
		wants: ReadonlyMap<string, boolean>;
	}[] = [];

	for (const [id, action] of actions) {
		if (action.kind === 'delete') {
			messagesToDelete.push(id);
			continue;
		}
		if (action.kind === 'labelPatch' && (await mailbox.hasMessage(id))) {
			labelPatches.push({ messageId: id, wants: action.wants });
			continue;
		}
		// A new or missing row needs its full resource before deltas can apply.
		const fetched = await client.getMessage(id);
		if (fetched.error) {
			if (fetched.error.name === 'Http' && fetched.error.status === 404) {
				messagesToDelete.push(id);
				continue;
			}
			return failedOutcome(
				'INCREMENTAL',
				'messages.get failed while resolving an added message',
				cursorBefore,
				fetched.error,
			);
		}
		messagesToUpsert.push(fetched.data);
	}

	const labels = await client.listLabels();
	if (labels.error) {
		log(
			`labels.list failed during incremental refresh: ${labels.error.message}`,
		);
	} else {
		await mailbox.ingestLabels(labels.data);
	}

	const { labelsChanged } = await mailbox.applyHistoryBatch({
		messagesToUpsert,
		messagesToDelete,
		labelPatches,
		newHistoryId,
		syncedAt,
	});

	return {
		mode: 'INCREMENTAL',
		reason: `applied ${records.length} history record(s)`,
		cursorBefore,
		cursorAfter: newHistoryId,
		messagesUpserted: messagesToUpsert.length,
		messagesDeleted: messagesToDelete.length,
		labelsPatched: labelsChanged,
		failure: null,
	};
}

/** Receive Gmail changes, populating the whole mailbox only without a valid cursor. */
export async function syncMailbox(deps: SyncDeps): Promise<SyncOutcome> {
	const { mailbox, now } = deps;
	const cursorBefore = (await mailbox.readCacheState()).historyId;
	let checkpoint = await mailbox.readFullPullCheckpoint();
	const syncedAt = new Date(now()).toISOString();
	let mode: SyncMode = cursorBefore && !checkpoint ? 'INCREMENTAL' : 'FULL';
	let reason = checkpoint
		? 'saved download checkpoint'
		: cursorBefore
			? 'saved history cursor'
			: 'no history cursor';
	let upserted = 0;
	let deleted = 0;
	try {
		if (cursorBefore && !checkpoint) {
			const outcome = await incrementalPoll(deps, cursorBefore, syncedAt);
			if (outcome.failure?.name !== 'HistoryExpired') return outcome;
			mode = 'FULL';
			reason = 'history cursor expired';
		}
		deps.log?.(`sync: FULL (${reason})`);
		for (let attempt = 0; ; attempt++) {
			const resuming = checkpoint !== null;
			if (!checkpoint) {
				// Capture before enumeration so changes during the download replay.
				const profile = await deps.client.getProfile();
				if (profile.error)
					return failedOutcome(
						mode,
						reason,
						cursorBefore,
						profile.error,
						upserted,
					);
				checkpoint = {
					historyId: profile.data.historyId,
					scanId: crypto.randomUUID(),
					syncedAt,
					nextPageToken: null,
				};
			}
			const pulled = await fullPull(deps, checkpoint, resuming);
			upserted += pulled.upserted;
			if (pulled.rejectedPageToken && attempt === 0) {
				checkpoint = null;
				reason = 'page token rejected; restarted enumeration';
				continue;
			}
			if (pulled.failure)
				return failedOutcome(
					mode,
					reason,
					cursorBefore,
					pulled.failure,
					upserted,
				);
			break;
		}
		deleted = await mailbox.finishFullPull(
			checkpoint.historyId,
			checkpoint.scanId,
		);
		// The baseline is durable now. Failed catchup resumes here next time,
		// without repeating the completed enumeration. Expiry is a bounded failure.
		const caughtUp = await incrementalPoll(
			deps,
			checkpoint.historyId,
			new Date(now()).toISOString(),
		);
		return {
			...caughtUp,
			mode,
			reason,
			cursorBefore,
			messagesUpserted: upserted + caughtUp.messagesUpserted,
			messagesDeleted: deleted + caughtUp.messagesDeleted,
		};
	} catch (cause) {
		if (!isSqliteBusy(cause)) throw cause;
		return {
			...failedOutcome(
				mode,
				reason,
				cursorBefore,
				CacheWriteError.CacheBusy({ cause }).error,
				upserted,
			),
			cursorAfter: (await mailbox.readCacheState()).historyId,
			messagesDeleted: deleted,
		};
	}
}
