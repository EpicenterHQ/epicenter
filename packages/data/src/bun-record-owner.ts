import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { customAlphabet } from 'nanoid';

import type { LensDefinition } from './lens.js';
import {
	advanceProposalWatermark,
	compileProposalArtifact,
	type ProposalArtifactStatus,
	type ProposalManifestEntry,
	type ProposalSelection,
	readProposalArtifactStatus,
	readProposalManifest,
} from './proposal-artifact.js';
import { SCALAR_SYNC_V1_LIMITS } from './protocol/v1/index.js';
import { createRecordOwner } from './record-epicenter.js';
import { createBunBlobFileStore } from './store/replica/bun-blob-files.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
} from './store/replica/index.js';

const mintReplicaId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);
const mintSnapshotId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);
const mintProposalId = customAlphabet('abcdef0123456789', 24);

const SNAPSHOT_PENDING_PREFIX = '.snapshot-';
const SNAPSHOT_PENDING_SUFFIX = '.pending';
const SNAPSHOT_ARTIFACT_PATTERN = /^snapshot-[a-z0-9]{24}\.sqlite3$/u;
const PROPOSAL_ARTIFACT_PATTERN = /^proposal-([a-f0-9]{24})\.sqlite3$/u;
const PROPOSAL_CLAIM_PATTERN = /^\.proposal-([a-f0-9]{24})-.+$/u;
const PROPOSAL_CLAIM_ARTIFACT = 'artifact.sqlite3';
const PROPOSAL_PENDING_PREFIX = '.proposal-';
const PROPOSAL_PENDING_SUFFIX = '.pending';
const PROPOSAL_HMAC_KEY = '.proposal-hmac-key';
const PROPOSAL_OWNER_LOCK = '.proposal-owner-lock.sqlite3';

export type BunProposalArtifact = ProposalArtifactStatus & {
	id: string;
	path: string;
};

export type BunInvalidProposalArtifact = {
	id: string;
	path: string;
	state: 'invalid';
	message: string;
};

export type BunProposalArtifactEntry =
	| BunProposalArtifact
	| BunInvalidProposalArtifact;

async function sweepSnapshotDebris(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (
			entry.isFile() &&
			((entry.name.startsWith(SNAPSHOT_PENDING_PREFIX) &&
				entry.name.endsWith(SNAPSHOT_PENDING_SUFFIX)) ||
				SNAPSHOT_ARTIFACT_PATTERN.test(entry.name))
		) {
			await rm(join(directory, entry.name), { force: true });
		}
	}
}

function errorCode(cause: unknown): string | undefined {
	return typeof cause === 'object' && cause !== null && 'code' in cause
		? String(cause.code)
		: undefined;
}

function acquireProposalOwnerLock(directory: string): () => void {
	const database = new Database(join(directory, PROPOSAL_OWNER_LOCK), {
		create: true,
		strict: true,
	});
	database.run('PRAGMA busy_timeout = 0');
	try {
		database.run('BEGIN EXCLUSIVE');
	} catch {
		database.close();
		throw new Error('Proposal directory is owned by another live process');
	}
	return () => {
		try {
			database.run('ROLLBACK');
		} finally {
			database.close();
		}
	};
}

async function readOrCreateProposalHmacKey(
	directory: string,
): Promise<Uint8Array> {
	const path = join(directory, PROPOSAL_HMAC_KEY);
	try {
		const bytes = await readFile(path);
		if (bytes.byteLength !== 32) {
			throw new Error('Proposal HMAC key has an invalid length');
		}
		return new Uint8Array(bytes);
	} catch (cause) {
		if (errorCode(cause) !== 'ENOENT') throw cause;
	}
	const published = (await readdir(directory, { withFileTypes: true })).some(
		(entry) =>
			(entry.isFile() && PROPOSAL_ARTIFACT_PATTERN.test(entry.name)) ||
			(entry.isDirectory() && PROPOSAL_CLAIM_PATTERN.test(entry.name)),
	);
	if (published) {
		throw new Error('Proposal HMAC key is missing while artifacts still exist');
	}
	const pendingPath = join(
		directory,
		`${PROPOSAL_PENDING_PREFIX}key-${mintProposalId()}${PROPOSAL_PENDING_SUFFIX}`,
	);
	const bytes = randomBytes(32);
	try {
		await writeFile(pendingPath, bytes, { flag: 'wx', mode: 0o600 });
		await link(pendingPath, path);
		await rm(pendingPath);
		return new Uint8Array(bytes);
	} catch (cause) {
		await rm(pendingPath, { force: true });
		if (errorCode(cause) === 'EEXIST') {
			const existing = await readFile(path);
			if (existing.byteLength !== 32) {
				throw new Error('Proposal HMAC key has an invalid length');
			}
			return new Uint8Array(existing);
		}
		throw cause;
	}
}

function proposalPath(directory: string, id: string): string {
	if (!/^[a-f0-9]{24}$/u.test(id)) throw new Error('Proposal ID is invalid');
	return join(directory, `proposal-${id}.sqlite3`);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (cause) {
		if (errorCode(cause) === 'ENOENT') return false;
		throw cause;
	}
}

function readProposalEntryAtPath(
	path: string,
	hmacKey: Uint8Array,
	id: string,
): BunProposalArtifactEntry {
	const artifact = new Database(path, { strict: true });
	try {
		const status = readProposalArtifactStatus({
			database: createBunSqliteAdapter(artifact),
			hmacKey,
		});
		if (status.proposalId !== id) {
			throw new Error('Proposal filename does not match its declaration');
		}
		return { id, path, ...status };
	} catch (cause) {
		return {
			id,
			path,
			state: 'invalid',
			message: cause instanceof Error ? cause.message : 'Proposal is invalid',
		};
	} finally {
		artifact.close();
	}
}

function readProposalEntry(
	directory: string,
	hmacKey: Uint8Array,
	id: string,
): BunProposalArtifactEntry {
	return readProposalEntryAtPath(proposalPath(directory, id), hmacKey, id);
}

type ProposalClaim = {
	path: string;
	claimDirectory: string;
	claimedPath: string;
};

async function restoreProposalClaim(claim: ProposalClaim): Promise<void> {
	try {
		await link(claim.claimedPath, claim.path);
	} catch (cause) {
		if (errorCode(cause) === 'EEXIST') {
			throw new Error('Proposal path was replaced during an owner operation');
		}
		throw cause;
	}
	await rm(claim.claimDirectory, { recursive: true });
}

async function claimProposal(
	directory: string,
	id: string,
): Promise<ProposalClaim> {
	const path = proposalPath(directory, id);
	const claimDirectory = await mkdtemp(join(directory, `.proposal-${id}-`));
	const claimedPath = join(claimDirectory, PROPOSAL_CLAIM_ARTIFACT);
	try {
		await rename(path, claimedPath);
	} catch (cause) {
		await rm(claimDirectory, { recursive: true, force: true });
		throw cause;
	}
	return { path, claimDirectory, claimedPath };
}

async function recoverProposalClaims(directory: string): Promise<void> {
	const claimsById = new Map<string, string[]>();
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const match = entry.isDirectory()
			? PROPOSAL_CLAIM_PATTERN.exec(entry.name)
			: null;
		const id = match?.[1];
		if (id === undefined) continue;
		const claimDirectories = claimsById.get(id) ?? [];
		claimDirectories.push(join(directory, entry.name));
		claimsById.set(id, claimDirectories);
	}
	for (const [id, claimDirectories] of claimsById) {
		if (claimDirectories.length !== 1) {
			throw new Error('Proposal has multiple interrupted owner claims');
		}
		const claimDirectory = claimDirectories[0];
		if (claimDirectory === undefined)
			throw new Error('Proposal claim is missing');
		const path = proposalPath(directory, id);
		const claimedPath = join(claimDirectory, PROPOSAL_CLAIM_ARTIFACT);
		const claim = { path, claimDirectory, claimedPath };
		if (!(await pathExists(claimedPath))) {
			await rm(claimDirectory, { recursive: true });
			continue;
		}
		if (await pathExists(path)) {
			const [canonical, claimed] = await Promise.all([
				lstat(path),
				lstat(claimedPath),
			]);
			if (canonical.dev !== claimed.dev || canonical.ino !== claimed.ino) {
				throw new Error('Proposal has conflicting canonical and claimed files');
			}
			await rm(claimDirectory, { recursive: true });
			continue;
		}
		await restoreProposalClaim(claim);
	}
}

async function sweepProposalDebris(
	directory: string,
	hmacKey: Uint8Array,
): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (
			entry.isFile() &&
			entry.name.startsWith(PROPOSAL_PENDING_PREFIX) &&
			entry.name.endsWith(PROPOSAL_PENDING_SUFFIX)
		) {
			await rm(path, { force: true });
			continue;
		}
		const match = entry.isFile()
			? PROPOSAL_ARTIFACT_PATTERN.exec(entry.name)
			: null;
		const id = match?.[1];
		if (id === undefined) continue;
		const claim = await claimProposal(directory, id);
		let completed = false;
		try {
			const proposal = readProposalEntryAtPath(claim.claimedPath, hmacKey, id);
			completed =
				proposal.state === 'compiled' &&
				proposal.appliedCount === proposal.changeCount;
		} finally {
			if (completed) await rm(claim.claimDirectory, { recursive: true });
			else await restoreProposalClaim(claim);
		}
	}
}

async function readProposalEntries(
	directory: string,
	hmacKey: Uint8Array,
): Promise<BunProposalArtifactEntry[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	return entries
		.flatMap((entry) => {
			const match = entry.isFile()
				? PROPOSAL_ARTIFACT_PATTERN.exec(entry.name)
				: null;
			const id = match?.[1];
			return id === undefined
				? []
				: [readProposalEntry(directory, hmacKey, id)];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

function assertProposalTrust(
	entries: readonly BunProposalArtifactEntry[],
): void {
	if (entries.some((entry) => entry.state === 'invalid')) {
		throw new Error(
			'Invalid Proposal artifacts must be deleted before creating another',
		);
	}
}

function localManifestWrite(entry: ProposalManifestEntry): {
	intent: Exclude<ProposalManifestEntry, { collision: 'refuse' }>;
	expectAbsent: boolean;
} {
	if ('collision' in entry) {
		return {
			intent: {
				address: entry.address,
				op: 'replace',
				value: entry.value,
			},
			expectAbsent: true,
		};
	}
	return { intent: entry, expectAbsent: false };
}

/** Open the Bun storage resources retained by one universal-record owner. */
export async function openBunRecordOwner({ directory }: { directory: string }) {
	await mkdir(directory, { recursive: true });
	const snapshotDirectory = join(directory, 'snapshots');
	const proposalDirectory = join(directory, 'proposals');
	await sweepSnapshotDebris(snapshotDirectory);
	await mkdir(proposalDirectory, { recursive: true });
	const releaseProposalOwnerLock = acquireProposalOwnerLock(proposalDirectory);
	try {
		const proposalHmacKey =
			await readOrCreateProposalHmacKey(proposalDirectory);
		await recoverProposalClaims(proposalDirectory);
		await sweepProposalDebris(proposalDirectory, proposalHmacKey);
		const rawDatabase = new Database(join(directory, 'epicenter.sqlite3'), {
			create: true,
			strict: true,
		});
		try {
			const database = createBunSqliteAdapter(rawDatabase);
			const replica = openReplicaStore({
				database,
				limits: SCALAR_SYNC_V1_LIMITS,
				initialize: { replicaId: mintReplicaId() },
			});
			const blobs = createReplicaBlobStore(
				database,
				createBunBlobFileStore(directory),
			);
			await blobs.reopenSweep();
			const proposalOperations = new Map<string, Promise<void>>();
			const activeProposalOperations = new Set<Promise<unknown>>();
			let acceptsProposalOperations = true;
			function registerProposalOperation<TResult>(
				operation: Promise<TResult>,
			): Promise<TResult> {
				activeProposalOperations.add(operation);
				void operation.then(
					() => activeProposalOperations.delete(operation),
					() => activeProposalOperations.delete(operation),
				);
				return operation;
			}
			function startProposalOperation<TResult>(
				operation: () => Promise<TResult>,
			): Promise<TResult> {
				if (!acceptsProposalOperations) {
					return Promise.reject(new Error('Proposal owner is disposed'));
				}
				return registerProposalOperation(Promise.resolve().then(operation));
			}
			function runProposalOperation<TResult>(
				id: string,
				operation: () => Promise<TResult>,
			): Promise<TResult> {
				if (!acceptsProposalOperations) {
					return Promise.reject(new Error('Proposal owner is disposed'));
				}
				const previous = proposalOperations.get(id) ?? Promise.resolve();
				const result = previous.then(operation);
				const tail = result.then(
					() => undefined,
					() => undefined,
				);
				proposalOperations.set(id, tail);
				void tail.then(() => {
					if (proposalOperations.get(id) === tail)
						proposalOperations.delete(id);
				});
				return registerProposalOperation(result);
			}
			const owner = createRecordOwner({
				replica,
				blobs,
				async dispose() {
					acceptsProposalOperations = false;
					await Promise.allSettled([...activeProposalOperations]);
					try {
						rawDatabase.close();
					} finally {
						await releaseProposalOwnerLock();
					}
				},
			});
			return {
				owner,
				replica,
				blobs,
				async captureSnapshot({ lens }: { lens?: LensDefinition } = {}) {
					const id = mintSnapshotId();
					const filename = `snapshot-${id}.sqlite3`;
					const pendingPath = join(
						snapshotDirectory,
						`${SNAPSHOT_PENDING_PREFIX}${id}${SNAPSHOT_PENDING_SUFFIX}`,
					);
					const path = join(snapshotDirectory, filename);
					const artifact = new Database(pendingPath, {
						create: true,
						strict: true,
					});
					let artifactOpen = true;
					try {
						const metadata = replica.captureSnapshot({
							database: createBunSqliteAdapter(artifact),
							...(lens === undefined ? {} : { lens }),
						});
						artifact.close();
						artifactOpen = false;
						await rename(pendingPath, path);
						return { path, metadata };
					} catch (cause) {
						if (artifactOpen) artifact.close(false);
						await rm(pendingPath, { force: true });
						throw cause;
					}
				},
				async proposals(): Promise<BunProposalArtifactEntry[]> {
					return startProposalOperation(async () =>
						readProposalEntries(proposalDirectory, proposalHmacKey),
					);
				},
				async createProposal({
					lens,
					selection,
				}: {
					lens: LensDefinition;
					selection: ProposalSelection;
				}): Promise<BunProposalArtifact> {
					const id = mintProposalId();
					return runProposalOperation(id, async () => {
						assertProposalTrust(
							await readProposalEntries(proposalDirectory, proposalHmacKey),
						);
						const pendingPath = join(
							proposalDirectory,
							`${PROPOSAL_PENDING_PREFIX}${id}${PROPOSAL_PENDING_SUFFIX}`,
						);
						const path = proposalPath(proposalDirectory, id);
						const artifact = new Database(pendingPath, {
							create: true,
							strict: true,
						});
						let artifactOpen = true;
						try {
							replica.captureProposal({
								database: createBunSqliteAdapter(artifact),
								hmacKey: proposalHmacKey,
								proposalId: id,
								lens,
								selection,
							});
							artifact.close();
							artifactOpen = false;
							await rename(pendingPath, path);
							const proposal = readProposalEntry(
								proposalDirectory,
								proposalHmacKey,
								id,
							);
							if (proposal.state === 'invalid')
								throw new Error(proposal.message);
							return proposal;
						} catch (cause) {
							if (artifactOpen) artifact.close(false);
							await rm(pendingPath, { force: true });
							await rm(path, { force: true });
							throw cause;
						}
					});
				},
				async compileProposal(id: string): Promise<BunProposalArtifact> {
					return runProposalOperation(id, async () => {
						const claim = await claimProposal(proposalDirectory, id);
						try {
							const artifact = new Database(claim.claimedPath, {
								strict: true,
							});
							try {
								compileProposalArtifact({
									database: createBunSqliteAdapter(artifact),
									hmacKey: proposalHmacKey,
								});
							} finally {
								artifact.close();
							}
							const proposal = readProposalEntryAtPath(
								claim.claimedPath,
								proposalHmacKey,
								id,
							);
							if (proposal.state === 'invalid')
								throw new Error(proposal.message);
							await restoreProposalClaim(claim);
							return { ...proposal, path: claim.path };
						} catch (cause) {
							if (await pathExists(claim.claimedPath)) {
								await restoreProposalClaim(claim);
							}
							throw cause;
						}
					});
				},
				async applyProposal(
					id: string,
				): Promise<{ proposalId: string; admittedChanges: number }> {
					return runProposalOperation(id, async () => {
						const claim = await claimProposal(proposalDirectory, id);
						let admittedChanges = 0;
						try {
							const artifact = new Database(claim.claimedPath, {
								strict: true,
							});
							const database = createBunSqliteAdapter(artifact);
							try {
								while (true) {
									const manifest = readProposalManifest({
										database,
										hmacKey: proposalHmacKey,
									});
									if (manifest.proposalId !== id) {
										throw new Error(
											'Proposal filename does not match its declaration',
										);
									}
									const entry = manifest.entries[manifest.appliedCount];
									if (entry === undefined) break;
									const write = localManifestWrite(entry);
									replica.admitFencedLocalWrite({
										sourceFence: {
											replicaId: manifest.sourceReplicaId,
											authorityLifetime: manifest.sourceAuthorityLifetime,
										},
										intent: write.intent,
										expectAbsent: write.expectAbsent,
									});
									admittedChanges += 1;
									advanceProposalWatermark({
										database,
										hmacKey: proposalHmacKey,
										fromAppliedCount: manifest.appliedCount,
									});
								}
							} finally {
								artifact.close();
							}
							await rm(claim.claimDirectory, { recursive: true });
							if (await pathExists(claim.path)) {
								throw new Error(
									'Proposal path was replaced during an owner operation',
								);
							}
							return { proposalId: id, admittedChanges };
						} catch (cause) {
							if (await pathExists(claim.claimedPath)) {
								await restoreProposalClaim(claim);
							}
							throw cause;
						}
					});
				},
				async deleteProposal(id: string): Promise<void> {
					await runProposalOperation(id, async () => {
						let claim: Awaited<ReturnType<typeof claimProposal>>;
						try {
							claim = await claimProposal(proposalDirectory, id);
						} catch (cause) {
							if (errorCode(cause) === 'ENOENT') {
								return;
							}
							throw cause;
						}
						await rm(claim.claimDirectory, { recursive: true });
						if (await pathExists(claim.path)) {
							throw new Error(
								'Proposal path was replaced during an owner operation',
							);
						}
					});
				},
			};
		} catch (cause) {
			rawDatabase.close();
			throw cause;
		}
	} catch (cause) {
		await releaseProposalOwnerLock();
		throw cause;
	}
}

export type BunRecordOwner = Awaited<ReturnType<typeof openBunRecordOwner>>;
