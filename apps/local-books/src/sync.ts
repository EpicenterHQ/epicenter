import type { AppConfig } from './config.ts';
import type { BooksDb, RealmState } from './db.ts';
import { entityDef, type QbObject } from './entities.ts';
import type { QbClient, QbClientError } from './qb-client.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type SyncMode = 'FULL' | 'INCREMENTAL';

export type ModeDecision = { mode: SyncMode; reason: string };

export type ModeInputs = {
	forceFull: boolean;
	realmState: RealmState;
	now: number;
	cdcSafeWindowDays: number;
	fullBackstopDays: number;
};

/**
 * Choose FULL vs INCREMENTAL from the realm's stored state alone (pure, so it is
 * unit testable without a network). The mirror has one high-water mark for the
 * whole company, so this is one decision per pass, not per entity. FULL wins
 * whenever incremental cannot be trusted: an explicit `--full`, no cursor yet, a
 * cursor older than the CDC lookback window (the gap is unrecoverable), or a
 * stale last-full-pull backstop.
 */
export function decideMode({
	forceFull,
	realmState,
	now,
	cdcSafeWindowDays,
	fullBackstopDays,
}: ModeInputs): ModeDecision {
	if (forceFull) return { mode: 'FULL', reason: 'forced (--full)' };

	const cursor = realmState.cdcCursor;
	if (!cursor) return { mode: 'FULL', reason: 'no cursor (first run)' };

	const cursorAgeDays = (now - Date.parse(cursor)) / DAY_MS;
	if (cursorAgeDays > cdcSafeWindowDays) {
		return {
			mode: 'FULL',
			reason: `cursor ${cursorAgeDays.toFixed(1)}d old exceeds ${cdcSafeWindowDays}d CDC window`,
		};
	}

	const lastFull = realmState.lastFullPullAt;
	if (!lastFull) return { mode: 'FULL', reason: 'no recorded full pull' };

	const fullAgeDays = (now - Date.parse(lastFull)) / DAY_MS;
	if (fullAgeDays > fullBackstopDays) {
		return {
			mode: 'FULL',
			reason: `last full pull ${fullAgeDays.toFixed(1)}d old exceeds ${fullBackstopDays}d backstop`,
		};
	}

	return {
		mode: 'INCREMENTAL',
		reason: `cursor ${cursorAgeDays.toFixed(1)}d old, within window`,
	};
}

export type EntitySyncResult = {
	entity: string;
	upserted: number;
	deleted: number;
	/**
	 * This entity was full-pulled this pass (a realm FULL, a new-entity backfill,
	 * or a `--entity` repair) rather than refreshed by CDC.
	 */
	backfilled: boolean;
};

export type SyncOutcome = {
	mode: SyncMode;
	reason: string;
	cursorBefore: string | null;
	/** The realm cursor after the pass; equals `cursorBefore` when it did not advance. */
	cursorAfter: string | null;
	entities: EntitySyncResult[];
	failures: { entity: string; error: QbClientError }[];
};

export type SyncDeps = {
	db: BooksDb;
	client: QbClient;
	config: AppConfig;
	now: () => number;
	log?: (message: string) => void;
};

/**
 * Full-pull each named entity through its query endpoint into the mirror (one
 * transaction per entity, no cursor advance). The shared work behind a realm
 * FULL, a new-entity backfill, and a `--entity` repair; who advances the realm
 * cursor afterward (and whether) is the caller's call.
 */
async function fullPullEach(
	deps: SyncDeps,
	names: string[],
	syncedAt: string,
	{ backfilled }: { backfilled: boolean },
): Promise<{
	entities: EntitySyncResult[];
	failures: SyncOutcome['failures'];
}> {
	const { db, client } = deps;
	const log = deps.log ?? (() => {});
	const entities: EntitySyncResult[] = [];
	const failures: SyncOutcome['failures'] = [];

	for (const name of names) {
		const def = entityDef(name);
		if (backfilled) log(`${name}: backfill`);
		const pulled = await client.queryAll(name);
		if (pulled.error) {
			failures.push({ entity: name, error: pulled.error });
			continue;
		}
		// The latch commits with the rows it records: a crash rolls both back, so
		// the next pass backfills this entity again rather than trusting a half pull.
		const counts = db.ingest([{ def, objects: pulled.data }], {
			syncedAt,
			fullPulled: [name],
		});
		const { upserted, deleted } = counts[name] ?? { upserted: 0, deleted: 0 };
		entities.push({ entity: name, upserted, deleted, backfilled });
	}

	return { entities, failures };
}

/**
 * Refresh the whole company in one pass. FULL re-pulls every configured entity
 * through its query endpoint (an honest asymmetry: each entity is its own query
 * endpoint), then advances the single realm cursor. INCREMENTAL fires ONE
 * batched `/cdc` call for all entities since that cursor and advances it, after
 * first backfilling any entity that has never been full-pulled (the `_meta`
 * latch is the only signal we need: CDC carries only changes since the cursor,
 * so a fresh entity must full-pull its history once before it can ride the batch).
 * The cursor advances only on a clean pass, so any failure re-pulls its window
 * next time (idempotent) instead of skipping it.
 */
export async function syncRealm(
	deps: SyncDeps,
	{ forceFull }: { forceFull: boolean },
): Promise<SyncOutcome> {
	const { db, client, config, now } = deps;
	const log = deps.log ?? (() => {});
	const names = config.entities;

	const realmState = db.readRealmState();
	const nowMs = now();
	const { mode, reason } = decideMode({
		forceFull,
		realmState,
		now: nowMs,
		cdcSafeWindowDays: config.cdcSafeWindowDays,
		fullBackstopDays: config.fullBackstopDays,
	});
	const cursorBefore = realmState.cdcCursor;
	// Next pass's cursor is the moment THIS pass started: any object changed while
	// the pull runs is re-fetched next time. Idempotent upserts make the overlap
	// harmless; the alternative (server time at end of pull) risks a lost edit.
	const cursorAfter = new Date(nowMs).toISOString();

	log(`realm: ${mode} (${reason})`);

	if (mode === 'FULL') {
		const { entities, failures } = await fullPullEach(
			deps,
			names,
			cursorAfter,
			{
				backfilled: false,
			},
		);
		// Advance the realm cursor only when every entity was pulled: a partial
		// failure leaves the missing entity uninitialized (no table), so the next
		// pass backfills it rather than skipping its history.
		const advanced = failures.length === 0;
		if (advanced) {
			db.ingest([], {
				syncedAt: cursorAfter,
				realmState: {
					cdcCursor: cursorAfter,
					lastFullPullAt: cursorAfter,
					lastSyncedAt: cursorAfter,
				},
			});
		}
		return {
			mode,
			reason,
			cursorBefore,
			cursorAfter: advanced ? cursorAfter : cursorBefore,
			entities,
			failures,
		};
	}

	// INCREMENTAL. Snapshot which entities were already initialized BEFORE
	// backfilling: a freshly-added entity (no `_meta` latch) is backfilled in
	// full and excluded from this pass's CDC (it is already current), while the
	// rest ride one batched CDC call. cursorBefore is non-null here (a null
	// cursor forces FULL above).
	const newNames: string[] = [];
	const cdcNames: string[] = [];
	for (const name of names) {
		if (db.isInitialized(entityDef(name))) {
			cdcNames.push(name);
		} else {
			newNames.push(name);
		}
	}

	const backfill = await fullPullEach(deps, newNames, cursorAfter, {
		backfilled: true,
	});
	const entities = backfill.entities;
	const failures = backfill.failures;

	let changes: Record<string, QbObject[]> = {};
	if (cdcNames.length > 0) {
		const changed = await client.cdc(cdcNames, cursorBefore as string);
		if (changed.error) {
			failures.push({ entity: '(cdc)', error: changed.error });
		} else {
			changes = changed.data.changes;
		}
	}

	// Apply every entity's changes AND advance the one realm cursor in ONE
	// transaction (whole-batch atomic). Advance only on a clean pass, so a backfill
	// or CDC failure keeps the cursor put and the next pass re-pulls the window.
	const advanced = failures.length === 0;
	const cdcEntries = cdcNames.map((name) => ({
		def: entityDef(name),
		objects: changes[name] ?? [],
	}));
	const counts = db.ingest(cdcEntries, {
		syncedAt: cursorAfter,
		realmState: advanced
			? {
					cdcCursor: cursorAfter,
					lastFullPullAt: realmState.lastFullPullAt,
					lastSyncedAt: cursorAfter,
				}
			: undefined,
	});
	for (const name of cdcNames) {
		entities.push({
			entity: name,
			...(counts[name] ?? { upserted: 0, deleted: 0 }),
			backfilled: false,
		});
	}

	return {
		mode,
		reason,
		cursorBefore,
		cursorAfter: advanced ? cursorAfter : cursorBefore,
		entities,
		failures,
	};
}

/**
 * Re-pull specific entity tables from scratch (`sync --entity <name>...`). A
 * targeted repair: it FULL-pulls just the named entities and deliberately does
 * NOT move the realm's high-water mark (advancing it would skip the entities the
 * repair did not touch). Use it to rebuild a single table or force a fresh pull
 * of one entity; the steady-state freshness job is the cursor-advancing realm
 * pass (`syncRealm`).
 */
export async function repairEntities(
	deps: SyncDeps,
	names: string[],
): Promise<SyncOutcome> {
	const log = deps.log ?? (() => {});
	const cursor = deps.db.readRealmState().cdcCursor;
	const syncedAt = new Date(deps.now()).toISOString();
	log(`repair: FULL pull of ${names.join(', ')} (realm cursor untouched)`);
	const { entities, failures } = await fullPullEach(deps, names, syncedAt, {
		backfilled: true,
	});
	return {
		mode: 'FULL',
		reason: 'repair (--entity)',
		cursorBefore: cursor,
		cursorAfter: cursor,
		entities,
		failures,
	};
}

export type SyncLoopOptions = {
	forceFull: boolean;
	intervalMs: number;
	/** Aborting the signal stops the loop after the current pass or sleep. */
	signal: AbortSignal;
	/** Called after each pass with its outcome and 1-based pass number. */
	onPass: (outcome: SyncOutcome, pass: number) => void;
};

/**
 * A sleep that resolves early when the signal aborts, so Ctrl-C is instant. The
 * abort listener is removed on the timeout path too: without that, a long-lived
 * loop would leak one dangling listener per pass.
 */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Run `syncRealm` on a loop until the signal aborts. The first pass honors
 * `forceFull`; every later pass is incremental (the cursor has advanced), so
 * `--full --interval` means "one full pull, then keep up with CDC".
 */
export async function runSyncLoop(
	deps: SyncDeps,
	opts: SyncLoopOptions,
): Promise<void> {
	let pass = 0;
	while (!opts.signal.aborted) {
		const outcome = await syncRealm(deps, {
			forceFull: opts.forceFull && pass === 0,
		});
		pass += 1;
		opts.onPass(outcome, pass);
		if (opts.signal.aborted) break;
		await interruptibleSleep(opts.intervalMs, opts.signal);
	}
}
