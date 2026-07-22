import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { DesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import type { LensDefinition } from '@epicenter/data/record';
import type { HomeSnapshotQueryResult } from './snapshot-query-execution.ts';
import {
	createSnapshotQueryProcessRunner,
	type SnapshotQueryProcessRunner,
} from './snapshot-query-process.ts';

export type { HomeSnapshotQueryResult } from './snapshot-query-execution.ts';

export type HomeSnapshotLens = 'raw' | 'chat' | 'honeycrisp' | 'whispering';

export type HomeSnapshot = {
	id: string;
	kind: 'snapshot';
	formatVersion: number;
	sourceAuthorityLifetime: string | null;
	sourceAuthorityAfterSequence: number;
	lens: HomeSnapshotLens;
	recordCount: number;
};

type SnapshotQueryServiceOptions = {
	captureSnapshot: DesktopRecordEpicenterOwner['captureSnapshot'];
	lenses: Record<Exclude<HomeSnapshotLens, 'raw'>, LensDefinition>;
	runQuery?: SnapshotQueryProcessRunner;
};

type OwnedSnapshot = HomeSnapshot & { path: string };

function readArtifactDeclaration(path: string) {
	const database = new Database(path, { readonly: true, strict: true });
	try {
		return database
			.query<
				{
					kind: string;
					format_version: number;
					source_authority_lifetime: string | null;
					source_authority_after_sequence: number;
				},
				[]
			>(
				`SELECT kind, format_version, source_authority_lifetime,
					source_authority_after_sequence
				FROM _epicenter_artifact WHERE singleton = 1`,
			)
			.get();
	} finally {
		database.close();
	}
}

/** Own Home's ephemeral artifact registry and bounded read-only query handles. */
export function createSnapshotQueryService({
	captureSnapshot,
	lenses,
	runQuery = createSnapshotQueryProcessRunner(),
}: SnapshotQueryServiceOptions) {
	const snapshots = new Map<string, OwnedSnapshot>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Snapshot query service is disposed');
	}

	return Object.freeze({
		async capture(lens: HomeSnapshotLens): Promise<HomeSnapshot> {
			requireOpen();
			const selectedLens = lens === 'raw' ? undefined : lenses[lens];
			const artifact = await captureSnapshot(
				selectedLens === undefined ? {} : { lens: selectedLens },
			);
			try {
				const declaration = readArtifactDeclaration(artifact.path);
				if (
					declaration === null ||
					declaration.kind !== 'snapshot' ||
					declaration.format_version !== artifact.metadata.formatVersion ||
					declaration.source_authority_lifetime !==
						artifact.metadata.sourceAuthorityLifetime ||
					declaration.source_authority_after_sequence !==
						artifact.metadata.sourceAuthorityAfterSequence
				) {
					throw new Error(
						'Captured artifact declaration does not match its owner',
					);
				}
				const id = randomBytes(16).toString('hex');
				const snapshot: OwnedSnapshot = {
					id,
					path: artifact.path,
					kind: 'snapshot',
					formatVersion: artifact.metadata.formatVersion,
					sourceAuthorityLifetime: artifact.metadata.sourceAuthorityLifetime,
					sourceAuthorityAfterSequence:
						artifact.metadata.sourceAuthorityAfterSequence,
					lens,
					recordCount: artifact.metadata.recordCount,
				};
				const previous = [...snapshots.entries()];
				const cleanup = await Promise.allSettled(
					previous.map(([, { path }]) => rm(path, { force: true })),
				);
				for (const [index, outcome] of cleanup.entries()) {
					if (outcome.status === 'fulfilled') {
						const previousId = previous[index]?.[0];
						if (previousId !== undefined) snapshots.delete(previousId);
					}
				}
				const cleanupFailures = cleanup
					.filter((outcome) => outcome.status === 'rejected')
					.map((outcome) => outcome.reason);
				if (cleanupFailures.length > 0) {
					throw new AggregateError(
						cleanupFailures,
						'Previous snapshot artifact cleanup failed',
					);
				}
				snapshots.set(id, snapshot);
				const { path: _path, ...publicSnapshot } = snapshot;
				return publicSnapshot;
			} catch (cause) {
				await rm(artifact.path, { force: true });
				throw cause;
			}
		},
		async query(
			snapshotId: string,
			sql: string,
		): Promise<HomeSnapshotQueryResult> {
			requireOpen();
			const snapshot = snapshots.get(snapshotId);
			if (snapshot === undefined) throw new Error('Snapshot does not exist');
			return runQuery({ path: snapshot.path, sql });
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			const paths = [...snapshots.values()].map(({ path }) => path);
			snapshots.clear();
			const outcomes = await Promise.allSettled(
				paths.map((path) => rm(path, { force: true })),
			);
			const failures = outcomes
				.filter((outcome) => outcome.status === 'rejected')
				.map((outcome) => outcome.reason);
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, 'Snapshot artifact cleanup failed');
			}
		},
	});
}

export type SnapshotQueryService = ReturnType<
	typeof createSnapshotQueryService
>;
