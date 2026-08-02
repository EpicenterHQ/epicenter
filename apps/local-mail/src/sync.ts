import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { AppConfig } from './config.ts';
import type { MailDb, RealmState } from './db.ts';
import type { GmailClient, GmailClientError } from './gmail-client.ts';
import type { GmailMessage, HistoryRecord } from './schema.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const FULL_PULL_GET_CHUNK_SIZE = 8;

export type SyncMode = 'FULL' | 'INCREMENTAL';
type ModeDecision = { mode: SyncMode; reason: string };

type ModeInputs = {
	forceFull: boolean;
	realmState: RealmState;
	now: number;
	historySafeWindowDays: number;
	fullBackstopDays: number;
};

/**
 * Choose FULL vs INCREMENTAL from the stored mailbox state alone (pure, so it
 * is unit testable without a network). Unlike `apps/local-books`' `decideMode`,
 * staleness is NOT derived from parsing the cursor: Gmail's `historyId` is an
 * opaque increasing integer, not a timestamp, so there is no cursor age to
 * compute. Instead this measures wall-clock time since our own last
 * successful sync (`lastSyncedAt`), which is the only staleness signal we
 * actually have.
 */
export function decideMode({
	forceFull,
	realmState,
	now,
	historySafeWindowDays,
	fullBackstopDays,
}: ModeInputs): ModeDecision {
	if (forceFull) return { mode: 'FULL', reason: 'forced (--full)' };

	if (!realmState.historyId)
		return { mode: 'FULL', reason: 'no cursor (first run)' };
	if (!realmState.lastSyncedAt) {
		return { mode: 'FULL', reason: 'cursor present but no recorded sync time' };
	}

	const sinceLastSyncDays =
		(now - Date.parse(realmState.lastSyncedAt)) / DAY_MS;
	if (sinceLastSyncDays > historySafeWindowDays) {
		return {
			mode: 'FULL',
			reason: `${sinceLastSyncDays.toFixed(1)}d since last sync exceeds ${historySafeWindowDays}d safe window (historyId retention is at least a week, not guaranteed longer)`,
		};
	}

	if (!realmState.lastFullPullAt)
		return { mode: 'FULL', reason: 'no recorded full pull' };
	const fullAgeDays = (now - Date.parse(realmState.lastFullPullAt)) / DAY_MS;
	if (fullAgeDays > fullBackstopDays) {
		return {
			mode: 'FULL',
			reason: `last full pull ${fullAgeDays.toFixed(1)}d old exceeds ${fullBackstopDays}d backstop`,
		};
	}

	return {
		mode: 'INCREMENTAL',
		reason: `synced ${sinceLastSyncDays.toFixed(1)}d ago, within window`,
	};
}

/**
 * A concurrent writer (another sync pass in a second process) held the mirror
 * lock past the 5s busy timeout. The failed transaction rolled back whole, so
 * the cursor did not advance and the next pass retries the same window; this
 * is a reportable outcome, not a crash, because a watch loop and an MCP host
 * syncing the same mirror is a supported arrangement.
 */
export const MirrorWriteError = defineErrors({
	MirrorBusy: ({ cause }: { cause: unknown }) => ({
		message: `The mirror is locked by another writer (${extractErrorMessage(cause)}). Nothing was lost; the next sync pass retries.`,
		cause,
	}),
});
export type MirrorWriteError = InferErrors<typeof MirrorWriteError>;

export type SyncFailure = GmailClientError | MirrorWriteError;

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
	db: MailDb;
	client: GmailClient;
	config: AppConfig;
	now: () => number;
	log?: (message: string) => void;
};

/** A failed pass: the cursor never moved, so `cursorAfter` always equals
 * `cursorBefore`, and every count is zero except `messagesUpserted` (a FULL
 * pull's per-page commits can have landed real rows before it failed). */
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

/**
 * Full pull: paginate `messages.list`, fetch each page's messages concurrently
 * via `messages.get(format=full)`, and commit per page (`ingestFullPullPage`).
 * Cursor advances only once, via `finishFullPull`, after every page succeeds
 * against the pre-pull `getProfile` baseline. Committing a page
 * that later fails means a retry re-pulls from `messages.list`'s first page
 * again (upserts are idempotent, so this repeats work rather than losing it,
 * the same tradeoff `apps/local-books` makes on a failed FULL pull).
 */
async function fullPull(
	deps: SyncDeps,
	syncedAt: string,
): Promise<{ upserted: number; failure: GmailClientError | null }> {
	const { db, client } = deps;
	const log = deps.log ?? (() => {});
	let upserted = 0;
	let pageToken: string | undefined;
	let page = 0;

	while (true) {
		page += 1;
		const listed = await client.listMessageIds(pageToken);
		if (listed.error) return { upserted, failure: listed.error };

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
				if (result.error) return { upserted, failure: result.error };
				messages.push(result.data);
			}
		}

		db.ingestFullPullPage(messages, syncedAt);
		upserted += messages.length;
		log(
			`full pull: page ${page}, ${messages.length} messages (${upserted} total)`,
		);

		if (!listed.data.nextPageToken) break;
		pageToken = listed.data.nextPageToken;
	}

	const labels = await client.listLabels();
	if (labels.error) return { upserted, failure: labels.error };
	db.ingestLabels(labels.data, syncedAt);

	return { upserted, failure: null };
}

/** Per-message final action after folding every history record for it, in order. */
type PendingAction =
	| { kind: 'upsert' }
	| { kind: 'delete' }
	| { kind: 'labelPatch'; labelIds: string[] };

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
		for (const { message } of [
			...(record.labelsAdded ?? []),
			...(record.labelsRemoved ?? []),
		]) {
			const existing = actions.get(message.id);
			if (existing?.kind === 'upsert' || existing?.kind === 'delete') continue;
			// `message.labelIds` on a labelsAdded/labelsRemoved record is the full
			// CURRENT snapshot, not the delta; the record's own top-level `labelIds`
			// is the delta and is intentionally unused here.
			actions.set(message.id, {
				kind: 'labelPatch',
				labelIds: message.labelIds ?? [],
			});
		}
	}
	return actions;
}

/**
 * Incremental refresh: paginate `history.list` from `cursorBefore`, fold every
 * record into a final per-message action, fetch full content for anything
 * that needs it, then apply the whole batch and advance the cursor in one
 * transaction (`db.applyHistoryBatch`). A `messages.get` 404 for a message
 * flagged `upsert` (added, then permanently deleted before we fetched it) is
 * folded into a delete rather than failing the pass. Any other failure aborts
 * without advancing the cursor, so the next pass re-pulls the same window.
 */
async function incrementalPoll(
	deps: SyncDeps,
	cursorBefore: string,
	syncedAt: string,
): Promise<SyncOutcome> {
	const { db, client } = deps;
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
	const labelPatches: { messageId: string; labelIds: string[] }[] = [];

	for (const [id, action] of actions) {
		if (action.kind === 'delete') {
			messagesToDelete.push(id);
			continue;
		}
		if (action.kind === 'labelPatch' && db.hasMessage(id)) {
			labelPatches.push({ messageId: id, labelIds: action.labelIds });
			continue;
		}
		// An upsert, or a label patch aimed at a row the mirror lacks: full
		// pulls exclude SPAM/TRASH, so the sweep can evict a row that a later
		// patch targets (untrash), and refetching converges the mirror.
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
		db.ingestLabels(labels.data, syncedAt);
	}

	const { labelsChanged } = db.applyHistoryBatch({
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

/**
 * One sync pass: decide FULL vs INCREMENTAL, run it, and (for INCREMENTAL)
 * fall back to FULL within the same pass if the cursor turns out to be
 * expired (`HistoryExpired`) even though `decideMode` thought it was fresh.
 */
export async function syncMailbox(
	deps: SyncDeps,
	{ forceFull }: { forceFull: boolean },
): Promise<SyncOutcome> {
	const { db, config, now } = deps;
	const log = deps.log ?? (() => {});

	const realmState = db.readRealmState();
	const nowMs = now();
	const decision = decideMode({
		forceFull,
		realmState,
		now: nowMs,
		historySafeWindowDays: config.historySafeWindowDays,
		fullBackstopDays: config.fullBackstopDays,
	});
	const cursorBefore = realmState.historyId;
	const syncedAt = new Date(nowMs).toISOString();
	let fullReason = decision.reason;
	log(`sync: ${decision.mode} (${decision.reason})`);

	// SQLITE_BUSY past the busy timeout throws out of the MailDb mutations;
	// map it to a failed outcome here so a lock lost to a concurrent writer
	// reports like any other failed pass instead of killing the process (CLI
	// watch) or corrupting into a protocol error (MCP). Anything else keeps
	// throwing: it is a bug, not an operational condition.
	try {
		if (decision.mode === 'INCREMENTAL' && cursorBefore) {
			const outcome = await incrementalPoll(deps, cursorBefore, syncedAt);
			if (!outcome.failure || outcome.failure.name !== 'HistoryExpired') {
				return outcome;
			}
			fullReason = 'historyId expired mid-pass';
			log('sync: historyId expired mid-pass, falling back to FULL');
		}

		const profile = await deps.client.getProfile();
		if (profile.error) {
			return failedOutcome('FULL', fullReason, cursorBefore, profile.error);
		}

		const { upserted, failure } = await fullPull(deps, syncedAt);
		if (failure) {
			return failedOutcome('FULL', fullReason, cursorBefore, failure, upserted);
		}

		const messagesDeleted = db.finishFullPull(profile.data.historyId, syncedAt);
		return {
			mode: 'FULL',
			reason: fullReason,
			cursorBefore,
			cursorAfter: profile.data.historyId,
			messagesUpserted: upserted,
			messagesDeleted,
			labelsPatched: 0,
			failure: null,
		};
	} catch (cause) {
		if (!isSqliteBusy(cause)) throw cause;
		return failedOutcome(
			decision.mode,
			decision.reason,
			cursorBefore,
			MirrorWriteError.MirrorBusy({ cause }).error,
		);
	}
}
