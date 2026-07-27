/**
 * The V1 replica: two independent scalar synchronization loops (ADR-0163).
 *
 * A replica has two jobs, and they are not phases of one exchange:
 *
 * - `pullFacts` learns current authority facts after one durable
 *   `afterSequence`, paging until the authority reports no more.
 * - `pushSubmissions` seals compacted pending intents into one numbered
 *   submission, retries that exact submission until it settles, and installs the
 *   settlement facts.
 *
 * They share storage and an authority lifetime and nothing else. Neither
 * sequences the other, neither blocks on the other's failure, and the supervisor
 * gives each its own retry cadence. That separation is the whole point of
 * ADR-0163: the previous combined exchange forced one cursor, one receipt, and
 * one scan ceiling to mean several overlapping things at once.
 *
 * Both loops end each network round trip with exactly one local transaction that
 * re-reads durable state, re-admits the response against it, installs facts, and
 * advances durable progress together. A crash before that commit repeats the
 * round trip; a crash after it resumes past the committed work. Nothing durable
 * moves outside such a transaction.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import { isRowAddress, isValueAddress } from '../protocol/addresses.js';
import { DATA_ADDRESS_CEILINGS } from '../protocol/admission.js';
import {
	type Address,
	addressKey,
	admitFactsPage,
	admitSettlement,
	canonicalize,
	type FactsRequest,
	type Intent,
	type JsonObject,
	type JsonValue,
	parseFactsRequest,
	parseIntent,
	parseSubmissionRequest,
	type RowAddress,
	SCALAR_V1_LIMITS,
	type SubmissionRequest,
	utf8ByteLength,
	type ValidatedLimits,
	type ValueAddress,
} from '../protocol/v1/index.js';
import {
	createReplicaV1Schema,
	REPLICA_V1_FORMAT_VERSION,
	REPLICA_V1_TABLES,
} from './v1-schema.js';
import {
	applyLocalWrite,
	deleteIntentBySequence,
	insertIntent,
	installConfirmedFact,
	parkIntent,
	readIntentsInState,
	readMetadata,
	readParked,
	readVisibleFact,
	type StoredIntent,
} from './v1-store.js';

const mintRuntimeId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

export const ReplicaV1Error = defineErrors({
	StorageFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Replica storage failed during ${operation}: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
	UnsupportedFormat: ({ found }: { found: number | null }) => ({
		message: `Replica format ${found === null ? 'is incomplete' : found} is not supported`,
		found,
	}),
	WrongAttachment: ({
		expectedDeploymentId,
		expectedPrincipalId,
		deploymentId,
		principalId,
	}: {
		expectedDeploymentId: string;
		expectedPrincipalId: string;
		deploymentId: string;
		principalId: string;
	}) => ({
		message:
			'This replica is permanently attached to another deployment or principal',
		expectedDeploymentId,
		expectedPrincipalId,
		deploymentId,
		principalId,
	}),
	NotAttached: () => ({ message: 'Attach the replica before synchronizing' }),
	InvalidInput: ({ boundary }: { boundary: string }) => ({
		message: `Invalid replica ${boundary}`,
		boundary,
	}),
	/**
	 * A response that did not survive context-aware admission against the exact
	 * request that produced it. Distinct from `TransportFailed` because the bytes
	 * arrived: retrying immediately would very likely reproduce it, so this must
	 * not inherit the transport's fast backoff.
	 */
	InvalidResponse: ({
		operation,
		reason,
	}: {
		operation: 'facts' | 'submission';
		reason: string;
	}) => ({
		message: `Invalid ${operation} response: ${reason}`,
		operation,
		reason,
	}),
	/**
	 * The authority is serving a different lifetime than this replica is bound to.
	 *
	 * Terminal, and deliberately its own variant: ADR-0163 recovers by erasing the
	 * superseded replica, binding to the successor, and reacquiring from zero.
	 * That is destructive, so it is never something a retry policy may trigger on
	 * its own; the owner decides.
	 */
	LifetimeMismatch: ({
		bound,
		active,
	}: {
		bound: string | undefined;
		active: string;
	}) => ({
		message:
			'The authority has a different lifetime; this replica must be erased and rebound',
		bound,
		active,
	}),
	/**
	 * Durable local state disagrees with the authority in a way no retry can fix:
	 * an `afterSequence` past the authority's own sequence in the same lifetime,
	 * or an equal authority sequence carrying different content. ADR-0163 calls
	 * this corruption rather than Restore recovery, so it is reported, not healed.
	 */
	Corrupted: ({ detail }: { detail: string }) => ({
		message: `Replica state is corrupt: ${detail}`,
		detail,
	}),
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Scalar transport failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StorageLimit: () => ({ message: 'The authority storage limit was reached' }),
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Replica change subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * A loop threw instead of returning a Result: a programming bug, or an
	 * injected transport that rejected outside its own Result adaptation.
	 *
	 * Its own variant so it cannot inherit the transport retry policy, which would
	 * turn a bug into a hot retry loop hidden behind an "offline" status.
	 */
	SyncFaulted: ({ cause }: { cause: unknown }) => ({
		message: `Sync faulted unexpectedly: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ReplicaV1Error = InferErrors<typeof ReplicaV1Error>;

/**
 * What the authority refused, as a value rather than an exception.
 *
 * These are expected protocol outcomes with distinct recoveries, so a transport
 * must report them separately from a network failure and from a 2xx body. The
 * replica maps each to its own error variant; nothing here is a programming
 * fault.
 */
export type AuthorityRefusal =
	| { code: 'lifetime-mismatch'; activeLifetime: string }
	| { code: 'sequence-ahead' }
	| { code: 'submission-fork' }
	| { code: 'submission-gap' }
	| { code: 'storage-limit' };

export type TransportOutcome =
	| { kind: 'response'; body: unknown }
	| { kind: 'refused'; refusal: AuthorityRefusal };

/**
 * The two private runtime operations, as the replica sees them.
 *
 * Bodies come back as `unknown` on purpose: the kernel's context-aware
 * admission (`admitFactsPage`, `admitSettlement`) is the only thing allowed to
 * decide a response is usable, and it needs the sealed request plus durable
 * state to do it. A transport that parsed responses itself would be a second,
 * weaker protocol boundary.
 */
export type ScalarTransport = {
	readFacts(request: FactsRequest): Promise<TransportOutcome>;
	submit(request: SubmissionRequest): Promise<TransportOutcome>;
};

export type OpenReplicaV1Options = {
	database: SqliteDatabase;
	limits?: ValidatedLimits;
	mintReplicaId?: () => string;
	log?: Logger;
};

function storageResult<T>(
	operation: string,
	run: () => T,
): Result<T, ReplicaV1Error> {
	return trySync({
		try: run,
		catch: (cause) => ReplicaV1Error.StorageFailed({ operation, cause }),
	});
}

/** A local failure raised inside a transaction so the transaction rolls back. */
class LoopFailure extends Error {
	constructor(readonly failure: ReplicaV1Error) {
		super(failure.message);
	}
}

function createReplicaV1(
	database: SqliteDatabase,
	limits: ValidatedLimits,
	log: Logger,
) {
	let nextLocalSequence =
		(database.all<SqliteRow & { sequence: number }>(
			`SELECT COALESCE(MAX(local_sequence), 0) AS sequence FROM (
				SELECT local_sequence FROM main._replica_v1_row_intents
				UNION ALL SELECT local_sequence FROM main._replica_v1_value_intents
			)`,
		)[0]?.sequence ?? 0) + 1;

	const changeListeners = new Set<(changes: readonly Address[]) => void>();
	const outboxListeners = new Set<() => void>();

	function notify(changes: readonly Address[]): void {
		if (changes.length === 0) return;
		for (const listener of changeListeners) {
			try {
				listener(changes);
			} catch (cause) {
				log.error(ReplicaV1Error.SubscriberThrew({ cause }).error);
			}
		}
	}

	/**
	 * Wake the outbox subscribers for a committed local write. Contained exactly
	 * like {@link notify}: these start background synchronization, so letting one
	 * throw would surface an unrelated sync failure as the local write's failure.
	 */
	function notifyOutbox(): void {
		for (const listener of outboxListeners) {
			try {
				listener();
			} catch (cause) {
				log.error(ReplicaV1Error.SubscriberThrew({ cause }).error);
			}
		}
	}

	function metadata() {
		return storageResult('read metadata', () => readMetadata(database));
	}

	function attach({
		deploymentId,
		principalId,
	}: {
		deploymentId: string;
		principalId: string;
	}): Result<void, ReplicaV1Error> {
		if (deploymentId.length === 0 || principalId.length === 0) {
			return ReplicaV1Error.InvalidInput({ boundary: 'attachment' });
		}
		try {
			if (new URL(deploymentId).href !== deploymentId) {
				return ReplicaV1Error.InvalidInput({
					boundary: 'canonical deployment URL',
				});
			}
		} catch {
			return ReplicaV1Error.InvalidInput({
				boundary: 'canonical deployment URL',
			});
		}
		try {
			database.transaction(() => {
				const current = readMetadata(database);
				if (current.attachment === undefined) {
					database.run(
						`UPDATE main._replica_v1_metadata
						SET attached_deployment = ?, attached_principal = ?
						WHERE singleton = 1`,
						[deploymentId, principalId],
					);
					return;
				}
				if (
					current.attachment.deploymentId === deploymentId &&
					current.attachment.principalId === principalId
				) {
					return;
				}
				throw new LoopFailure(
					ReplicaV1Error.WrongAttachment({
						expectedDeploymentId: current.attachment.deploymentId,
						expectedPrincipalId: current.attachment.principalId,
						deploymentId,
						principalId,
					}).error,
				);
			});
			return Ok(undefined);
		} catch (cause) {
			if (cause instanceof LoopFailure)
				return { data: null, error: cause.failure };
			return ReplicaV1Error.StorageFailed({ operation: 'attach', cause });
		}
	}

	/**
	 * Apply one local intent optimistically and queue it for the authority.
	 *
	 * Local-first means this returns as soon as the write is durable; nothing here
	 * waits on, or even wakes, the network. The outbox notification is what lets
	 * the submissions loop decide when to run.
	 */
	function write(
		rawIntent: Intent,
	): Result<{ applied: boolean }, ReplicaV1Error> {
		const { data: intent, error } = parseIntent(rawIntent, limits);
		if (error !== null) {
			return ReplicaV1Error.InvalidInput({ boundary: 'intent' });
		}
		const result = storageResult('write', () =>
			database.transaction(() => {
				const applied = applyLocalWrite(database, intent, nextLocalSequence);
				if (applied.applied) nextLocalSequence += 1;
				return applied;
			}),
		);
		if (result.error === null && result.data.applied) {
			notify([intent.address]);
			notifyOutbox();
		}
		return result;
	}

	function subscribe(
		listener: (changes: readonly Address[]) => void,
	): () => void {
		changeListeners.add(listener);
		return () => changeListeners.delete(listener);
	}

	function subscribeOutbox(listener: () => void): () => void {
		outboxListeners.add(listener);
		return () => outboxListeners.delete(listener);
	}

	function readRow(
		address: RowAddress,
	): Result<JsonObject | undefined, ReplicaV1Error> {
		if (!isRowAddress(address, DATA_ADDRESS_CEILINGS)) {
			return ReplicaV1Error.InvalidInput({ boundary: 'row address' });
		}
		return storageResult('read row', () => {
			const fact = readVisibleFact(database, address);
			return fact !== undefined && 'fields' in fact
				? structuredClone(fact.fields)
				: undefined;
		});
	}

	function readValue(
		address: ValueAddress,
	): Result<JsonValue | undefined, ReplicaV1Error> {
		if (!isValueAddress(address, DATA_ADDRESS_CEILINGS)) {
			return ReplicaV1Error.InvalidInput({ boundary: 'value address' });
		}
		return storageResult('read value', () => {
			const fact = readVisibleFact(database, address);
			return fact !== undefined && 'content' in fact
				? structuredClone(fact.content)
				: undefined;
		});
	}

	function refusalToError(
		refusal: AuthorityRefusal,
		bound: string | undefined,
	): ReplicaV1Error {
		switch (refusal.code) {
			case 'lifetime-mismatch':
				return ReplicaV1Error.LifetimeMismatch({
					bound,
					active: refusal.activeLifetime,
				}).error;
			case 'sequence-ahead':
				return ReplicaV1Error.Corrupted({
					detail:
						'the durable afterSequence is past the authority in the same lifetime',
				}).error;
			case 'submission-fork':
				return ReplicaV1Error.Corrupted({
					detail:
						'the authority saw a different request at this submission number',
				}).error;
			case 'submission-gap':
				return ReplicaV1Error.Corrupted({
					detail: 'the submission number skipped the authority next number',
				}).error;
			case 'storage-limit':
				return ReplicaV1Error.StorageLimit().error;
			default:
				return refusal satisfies never;
		}
	}

	// -----------------------------------------------------------------------
	// Loop one: learn current authority facts
	// -----------------------------------------------------------------------

	/**
	 * Page current authority facts until the authority reports no more.
	 *
	 * Each page commits as one transaction that re-reads durable state, re-admits
	 * the page against the exact request that produced it, installs the whole
	 * returned prefix, and advances `afterSequence` to the prefix's final
	 * sequence. The next cursor is derived from the last returned fact and never
	 * sent, because the query is already exclusive and sequence gaps are valid.
	 *
	 * Submission facts never advance this watermark; only this loop does.
	 */
	async function pullFacts(
		transport: ScalarTransport,
	): Promise<Result<void, ReplicaV1Error>> {
		while (true) {
			const current = metadata();
			if (current.error !== null) return current;
			if (current.data.attachment === undefined) {
				return ReplicaV1Error.NotAttached();
			}

			const requested: FactsRequest = {
				...(current.data.authorityLifetime === undefined
					? {}
					: { authorityLifetime: current.data.authorityLifetime }),
				afterSequence: current.data.afterSequence,
			};
			const { data: admitted, error: requestError } = parseFactsRequest(
				requested,
				limits,
			);
			if (requestError !== null) {
				return ReplicaV1Error.Corrupted({
					detail: `durable facts progress is not a valid request: ${requestError.message}`,
				});
			}

			let outcome: TransportOutcome;
			try {
				outcome = await transport.readFacts(requested);
			} catch (cause) {
				return ReplicaV1Error.TransportFailed({ cause });
			}
			if (outcome.kind === 'refused') {
				return {
					data: null,
					error: refusalToError(
						outcome.refusal,
						current.data.authorityLifetime,
					),
				};
			}

			const installed = storageResult('install facts page', () =>
				database.transaction(() => {
					const durable = readMetadata(database);
					const { data: page, error } = admitFactsPage(
						outcome.body,
						admitted,
						{
							...(durable.authorityLifetime === undefined
								? {}
								: { authorityLifetime: durable.authorityLifetime }),
							afterSequence: durable.afterSequence,
						},
						limits,
					);
					if (error !== null) {
						throw new LoopFailure(
							ReplicaV1Error.InvalidResponse({
								operation: 'facts',
								reason: error.message,
							}).error,
						);
					}

					const changes = new Map<string, Address>();
					for (const fact of page.facts) {
						const result = installConfirmedFact(database, fact);
						if (!result.identical) {
							throw new LoopFailure(
								ReplicaV1Error.Corrupted({
									detail:
										'an equal authority sequence carried different content',
								}).error,
							);
						}
						if (result.installed) {
							changes.set(addressKey(fact.address), fact.address);
						}
					}

					// Derived, never sent. An empty page keeps the requested cursor.
					const nextAfterSequence =
						page.facts.at(-1)?.sequence ?? durable.afterSequence;
					database.run(
						`UPDATE main._replica_v1_metadata
						SET authority_lifetime = ?, after_sequence = ?
						WHERE singleton = 1`,
						[page.authorityLifetime, nextAfterSequence],
					);
					return { changes: [...changes.values()], hasMore: page.hasMore };
				}),
			);
			if (installed.error !== null) {
				return unwrapLoopFailure(installed.error);
			}
			notify(installed.data.changes);
			if (!installed.data.hasMore) return Ok(undefined);
		}
	}

	// -----------------------------------------------------------------------
	// Loop two: submit one numbered stream of local intents
	// -----------------------------------------------------------------------

	/**
	 * Seal the compacted pending intents into the next numbered submission.
	 *
	 * Returns the sealed request, or `undefined` when there is nothing to send.
	 * Sealing is idempotent across a crash: an already sealed submission is
	 * rebuilt from storage rather than resealed, so a retry resends the same
	 * replica id, number, and semantic intents.
	 */
	function sealSubmission(
		replicaId: string,
		authorityLifetime: string,
	): SubmissionRequest | undefined {
		const existingSealed = readIntentsInState(
			database,
			'sealed',
			limits.maxSubmissionAddresses,
		);
		const durable = readMetadata(database);
		if (existingSealed.length > 0) {
			if (durable.sealedSubmissionNumber === undefined) {
				throw new Error(
					'Sealed intents exist without a sealed submission number',
				);
			}
			return {
				authorityLifetime,
				replicaId,
				submissionNumber: durable.sealedSubmissionNumber,
				intents: existingSealed.map((stored) => stored.intent),
			};
		}

		const pending = readIntentsInState(
			database,
			'pending',
			limits.maxSubmissionAddresses,
		);
		if (pending.length === 0) return undefined;

		const submissionNumber = durable.lastSubmissionNumber + 1;
		// Take the largest prefix that fits the request ceiling. Splitting pending
		// work across more submissions is free: scalar addresses converge
		// independently, so a submission is a transport group and never a commit.
		const selected: StoredIntent[] = [];
		for (const stored of pending) {
			const candidate: SubmissionRequest = {
				authorityLifetime,
				replicaId,
				submissionNumber,
				intents: [...selected, stored].map((entry) => entry.intent),
			};
			if (utf8ByteLength(canonicalize(candidate)) > limits.maxSubmissionBytes) {
				break;
			}
			selected.push(stored);
		}
		if (selected.length === 0) {
			throw new Error(
				'One pending intent exceeds the submission admission limit',
			);
		}

		for (const stored of selected) {
			// Rewritten at the same local sequence so sealed work keeps its position
			// relative to any newer pending intent at the same address.
			deleteIntentBySequence(database, stored.localSequence);
			insertIntent(database, stored.localSequence, 'sealed', stored.intent);
		}
		database.run(
			`UPDATE main._replica_v1_metadata SET sealed_submission_number = ?
			WHERE singleton = 1`,
			[submissionNumber],
		);
		return {
			authorityLifetime,
			replicaId,
			submissionNumber,
			intents: selected.map((stored) => stored.intent),
		};
	}

	/**
	 * Submit one sealed numbered submission and install its settlement.
	 *
	 * Returns whether pending work remains, so the caller can decide to run again
	 * without this loop owning a schedule. The settlement facts install under the
	 * same monotonic rule as the facts feed, which is what stops a delayed
	 * response carrying an older fact than the feed already learned. Settlement
	 * never advances `afterSequence`.
	 */
	async function pushSubmissions(
		transport: ScalarTransport,
	): Promise<Result<{ hasMorePending: boolean }, ReplicaV1Error>> {
		const current = metadata();
		if (current.error !== null) return current;
		if (current.data.attachment === undefined) {
			return ReplicaV1Error.NotAttached();
		}
		const authorityLifetime = current.data.authorityLifetime;
		if (authorityLifetime === undefined) {
			// ADR-0163: a replica binds to the authority lifetime through the facts
			// feed before it may submit. This is ordinary ordering, not a failure.
			return Ok({ hasMorePending: true });
		}

		const sealed = storageResult('seal submission', () =>
			database.transaction(() =>
				sealSubmission(current.data.replicaId, authorityLifetime),
			),
		);
		if (sealed.error !== null) return sealed;
		if (sealed.data === undefined) return Ok({ hasMorePending: false });
		const request = sealed.data;

		const { data: admittedRequest, error: requestError } =
			parseSubmissionRequest(request, limits);
		if (requestError !== null) {
			return ReplicaV1Error.Corrupted({
				detail: `sealed submission is not admissible: ${requestError.message}`,
			});
		}

		let outcome: TransportOutcome;
		try {
			outcome = await transport.submit(request);
		} catch (cause) {
			return ReplicaV1Error.TransportFailed({ cause });
		}
		if (outcome.kind === 'refused') {
			return {
				data: null,
				error: refusalToError(outcome.refusal, authorityLifetime),
			};
		}

		const settled = storageResult('install settlement', () =>
			database.transaction(() => {
				const durable = readMetadata(database);
				const sealedNow = readIntentsInState(
					database,
					'sealed',
					limits.maxSubmissionAddresses,
				);
				const { data: response, error } = admitSettlement(
					outcome.body,
					admittedRequest,
					{
						authorityLifetime: durable.authorityLifetime ?? '',
						sealedSubmission:
							sealedNow.length === 0
								? undefined
								: {
										authorityLifetime: durable.authorityLifetime ?? '',
										replicaId: durable.replicaId,
										submissionNumber: durable.sealedSubmissionNumber ?? 0,
										intents: sealedNow.map((stored) => stored.intent),
									},
					},
					limits,
				);
				if (error !== null) {
					throw new LoopFailure(
						ReplicaV1Error.InvalidResponse({
							operation: 'submission',
							reason: error.message,
						}).error,
					);
				}

				const changes = new Map<string, Address>();
				for (const fact of response.facts) {
					const result = installConfirmedFact(database, fact);
					if (!result.identical) {
						throw new LoopFailure(
							ReplicaV1Error.Corrupted({
								detail: 'an equal authority sequence carried different content',
							}).error,
						);
					}
					if (result.installed) {
						changes.set(addressKey(fact.address), fact.address);
					}
				}

				const parkedByAddress = new Map(
					response.parked.map((entry) => [addressKey(entry.address), entry]),
				);
				for (const stored of sealedNow) {
					const key = addressKey(stored.intent.address);
					deleteIntentBySequence(database, stored.localSequence);
					const parked = parkedByAddress.get(key);
					if (parked === undefined) continue;
					// ADR-0163: after monotonic installation, inspect the stored fact,
					// not the returned one. A terminal tombstone underneath supersedes
					// the parked overlay and its diagnostic entirely.
					const stillLive = readVisibleFact(database, stored.intent.address);
					if (stillLive?.presence === 'absent') continue;
					parkIntent(database, parked, stored.intent, nextLocalSequence);
					nextLocalSequence += 1;
				}

				database.run(
					`UPDATE main._replica_v1_metadata
					SET last_submission_number = ?, sealed_submission_number = NULL
					WHERE singleton = 1`,
					[durable.sealedSubmissionNumber ?? durable.lastSubmissionNumber],
				);

				const hasMorePending =
					readIntentsInState(database, 'pending', 1).length > 0;
				return { changes: [...changes.values()], hasMorePending };
			}),
		);
		if (settled.error !== null) return unwrapLoopFailure(settled.error);
		notify(settled.data.changes);
		return Ok({ hasMorePending: settled.data.hasMorePending });
	}

	function parkedDiagnostics() {
		return storageResult('read parked', () => readParked(database));
	}

	return {
		metadata,
		attach,
		write,
		readRow,
		readValue,
		subscribe,
		subscribeOutbox,
		pullFacts,
		pushSubmissions,
		parkedDiagnostics,
	};
}

export type ReplicaV1 = ReturnType<typeof createReplicaV1>;

// Re-exported so `v1-replica.js` is the one module a consumer needs to import
// for the replica: its format version and metadata shape are part of that
// surface even though they are declared beside the schema and the store.
export { REPLICA_V1_FORMAT_VERSION } from './v1-schema.js';
export type { ReplicaV1Metadata } from './v1-store.js';

/**
 * Recover the typed failure a transaction rolled back on.
 *
 * `storageResult` wraps everything a transaction throws as `StorageFailed`, but
 * a loop deliberately throws `LoopFailure` to roll back on a typed protocol or
 * corruption outcome. Reporting those as storage failures would hand a protocol
 * refusal the storage retry policy and hide it behind the wrong diagnosis.
 */
function unwrapLoopFailure<T>(
	failure: ReplicaV1Error,
): Result<T, ReplicaV1Error> {
	if (
		failure.name === 'StorageFailed' &&
		failure.cause instanceof LoopFailure
	) {
		return { data: null, error: failure.cause.failure };
	}
	return { data: null, error: failure };
}

export function openReplicaV1({
	database,
	limits = SCALAR_V1_LIMITS,
	mintReplicaId = mintRuntimeId,
	log = createLogger('data/replica-v1'),
}: OpenReplicaV1Options): Result<ReplicaV1, ReplicaV1Error> {
	try {
		// "Fresh" has to mean the file holds nothing at all, not merely nothing this
		// format recognizes. Asking only about the current relation names would read
		// a file full of a previous format's tables as empty and build a second,
		// parallel schema beside them: two live layouts in one file, each invisible
		// to the other, and the older one silently orphaned.
		const present = database
			.all<SqliteRow & { name: string }>(
				`SELECT name FROM main.sqlite_schema
				WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
			)
			.map((row) => row.name);
		if (present.length === 0) {
			const replicaId = mintReplicaId();
			database.transaction(() => createReplicaV1Schema(database, replicaId));
		} else {
			const expected = new Set<string>(REPLICA_V1_TABLES);
			const isCurrentFormat =
				present.length === expected.size &&
				present.every((name) => expected.has(name));
			if (!isCurrentFormat) {
				return ReplicaV1Error.UnsupportedFormat({ found: null });
			}
		}
		const current = readMetadata(database);
		if (current.formatVersion !== REPLICA_V1_FORMAT_VERSION) {
			return ReplicaV1Error.UnsupportedFormat({ found: current.formatVersion });
		}
		return Ok(createReplicaV1(database, limits, log));
	} catch (cause) {
		return ReplicaV1Error.StorageFailed({ operation: 'open', cause });
	}
}
