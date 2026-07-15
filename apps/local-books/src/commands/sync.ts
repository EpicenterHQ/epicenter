import ms from 'ms';
import { createQbAccess } from '../books/qb-access.ts';
import type { ParsedArgs } from '../cli.ts';
import { openBooksDb } from '../db.ts';
import { DEFAULT_ENTITIES, isKnownEntity } from '../entities.ts';
import { acquireSyncLock, syncOwnerBusyMessage } from '../lock.ts';
import { dbPath } from '../paths.ts';
import {
	repairEntities,
	runSyncLoop,
	type SyncDeps,
	type SyncOutcome,
	syncRealm,
} from '../sync.ts';
import { resolveCompany } from './context.ts';

/** Print one sync pass: the realm line + per-entity counts to stdout, failures to stderr. */
function reportOutcome(o: SyncOutcome): void {
	console.log(
		`${o.mode.padEnd(11)} ${o.reason}` +
			`  cursor ${o.cursorBefore ?? '(none)'} -> ${o.cursorAfter ?? '(none)'}`,
	);
	for (const e of o.entities) {
		console.log(
			`${e.entity.padEnd(13)} ${e.upserted} added or updated, ${e.deleted} removed` +
				`${e.backfilled ? '  [full pull]' : ''}`,
		);
	}
	for (const f of o.failures) {
		console.error(`${f.entity}: sync failed: ${f.error.message}`);
	}
}

/**
 * Refresh the local mirror. The default is a realm pass: one mode decision for
 * the whole company (FULL vs INCREMENTAL from the stored cursor; `--full`
 * forces FULL), advancing the single realm cursor. `--entity <name>...` instead
 * runs a targeted FULL repair of just those tables, leaving the cursor untouched.
 * The separate `watch` command keeps realm passes running until interrupted.
 */
export async function runSync(args: ParsedArgs): Promise<number> {
	const watching = args.command === 'watch';
	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, store } = company;

	const repairTargets = args.entities;
	const unknown = repairTargets.filter((name) => !isKnownEntity(name));
	if (unknown.length > 0) {
		console.error(
			`Unknown entities: ${unknown.join(', ')}. Known: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
		return 1;
	}
	if (watching && repairTargets.length > 0) {
		console.error(
			'Cannot combine watch with --entity. Run a one-time "sync --entity" repair, then start watch.',
		);
		return 1;
	}
	if (!watching && args.intervalMs != null) {
		console.error('--interval is only valid with local-books watch.');
		return 1;
	}
	const lock = acquireSyncLock({ dataDir: config.dataDir, realmId });
	if (!lock) {
		console.log(syncOwnerBusyMessage(realmId));
		return 0;
	}

	let db: ReturnType<typeof openBooksDb> | null = null;
	try {
		const now = () => Date.now();
		const log = (m: string) => console.error(m);
		// The same opener report/recategorize/MCP use: it reloads the token and
		// builds the client, or returns a "run auth" reason. One way to open a client.
		const { data: client, error: openError } = await createQbAccess({
			config,
			realmId,
			store,
			now,
			log,
		})();
		if (openError !== null) {
			console.error(openError);
			return 1;
		}
		db = openBooksDb(dbPath(config.dataDir, realmId));
		const deps: SyncDeps = { db, client, config, now, log };

		// Looping mode: keep the mirror fresh until interrupted.
		if (watching) {
			const intervalMs = args.intervalMs ?? 5 * 60_000;
			const controller = new AbortController();
			const stop = () => {
				console.error('\nstopping...');
				controller.abort();
			};
			process.on('SIGINT', stop);
			process.on('SIGTERM', stop);
			console.error(
				`Syncing ${config.entities.join(', ')} for company ${realmId} (${config.environment}) every ${ms(intervalMs)}; press Ctrl-C to stop.`,
			);
			try {
				await runSyncLoop(deps, {
					forceFull: args.full,
					intervalMs,
					signal: controller.signal,
					onPass: reportOutcome,
				});
				return 0;
			} finally {
				process.off('SIGINT', stop);
				process.off('SIGTERM', stop);
			}
		}

		// Single pass: a targeted repair when `--entity` is given, else the realm pass.
		if (repairTargets.length > 0) {
			console.error(
				`Repairing ${repairTargets.join(', ')} for company ${realmId} (${config.environment})...`,
			);
			const outcome = await repairEntities(deps, repairTargets);
			reportOutcome(outcome);
			return outcome.failures.length > 0 ? 1 : 0;
		}

		console.error(
			`Syncing ${config.entities.join(', ')} for company ${realmId} (${config.environment})${args.full ? ' [--full]' : ''}...`,
		);
		const outcome = await syncRealm(deps, { forceFull: args.full });
		reportOutcome(outcome);
		return outcome.failures.length > 0 ? 1 : 0;
	} finally {
		db?.close();
		lock.release();
	}
}
