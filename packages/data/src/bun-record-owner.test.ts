/**
 * Bun record owner artifact tests.
 *
 * Verifies snapshot publication and the desktop Proposal lifecycle from
 * coherent capture through authenticated compilation, ordinary admission,
 * crash recovery, exclusive ownership, and final artifact deletion.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { openBunRecordOwner } from './bun-record-owner.js';
import { defineLens, defineTable } from './lens.js';
import {
	advanceProposalWatermark,
	type ProposalManifestEntry,
	readProposalManifest,
} from './proposal-artifact.js';

const NOTE_ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function notesLens() {
	return defineLens({
		namespace: NOTE_ADDRESS.namespace,
		title: 'Notes',
		description: 'Proposal fixture.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: { title: field.string() },
				optional: [],
			}),
		},
	});
}

function existingNoteSelection() {
	return {
		namespace: NOTE_ADDRESS.namespace,
		collections: {
			notes: {
				kind: 'table' as const,
				recordKeys: [NOTE_ADDRESS.recordKey],
				allowCreate: true,
			},
		},
	};
}

function ordinaryWrite(entry: ProposalManifestEntry) {
	return 'collision' in entry
		? {
				intent: {
					address: entry.address,
					op: 'replace' as const,
					value: entry.value,
				},
				expectAbsent: true,
			}
		: { intent: entry, expectAbsent: false };
}

test('Bun owner publishes only complete read-only snapshot artifacts', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-bun-owner-'));
	const snapshotDirectory = join(directory, 'snapshots');
	await mkdir(snapshotDirectory);
	const debris = join(snapshotDirectory, '.snapshot-crashed.pending');
	const publishedDebris = join(
		snapshotDirectory,
		'snapshot-aaaaaaaaaaaaaaaaaaaaaaaa.sqlite3',
	);
	await writeFile(debris, 'incomplete');
	await writeFile(publishedDebris, 'orphaned');
	const opened = await openBunRecordOwner({ directory });
	try {
		expect(await Bun.file(debris).exists()).toBe(false);
		expect(await Bun.file(publishedDebris).exists()).toBe(false);
		opened.replica.localWrite({
			address: {
				namespace: 'so.epicenter.notes',
				collection: 'notes',
				recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			},
			op: 'replace',
			value: { title: 'Captured' },
		});
		const lens = defineLens({
			namespace: 'so.epicenter.notes',
			title: 'Notes',
			description: 'Snapshot fixture.',
			collections: {
				notes: defineTable({
					title: 'Notes',
					fields: { title: field.string() },
					optional: [],
				}),
			},
		});
		const snapshot = await opened.captureSnapshot({ lens });
		expect(snapshot.metadata).toMatchObject({
			kind: 'snapshot',
			recordCount: 1,
		});
		expect(snapshot.path).toMatch(
			/\/snapshots\/snapshot-[a-z0-9]{24}\.sqlite3$/,
		);
		const artifact = new Database(snapshot.path, {
			readonly: true,
			strict: true,
		});
		try {
			expect(artifact.query('SELECT id, title FROM notes').get()).toEqual({
				id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				title: 'Captured',
			});
			expect(() => artifact.run('DELETE FROM _epicenter_records')).toThrow();
		} finally {
			artifact.close();
		}
	} finally {
		await opened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner applies a Proposal then deletes it while ordinary work remains', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-owner-'));
	const opened = await openBunRecordOwner({ directory });
	try {
		opened.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		const proposal = await opened.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
		const artifact = new Database(proposal.path, { strict: true });
		let createdId: string;
		try {
			artifact.run(`UPDATE notes SET title = 'After' WHERE id = ?`, [
				NOTE_ADDRESS.recordKey,
			]);
			artifact.run(`INSERT INTO notes (title) VALUES ('Created')`);
			const created = artifact
				.query<{ id: string }, []>(
					`SELECT id FROM notes WHERE title = 'Created'`,
				)
				.get();
			if (created === null) throw new Error('Proposal row was not created');
			createdId = created.id;
		} finally {
			artifact.close();
		}
		const compiled = await opened.compileProposal(proposal.id);
		expect(compiled).toMatchObject({
			state: 'compiled',
			changeCount: 2,
			appliedCount: 0,
		});
		const [applied] = await Promise.all([
			opened.applyProposal(proposal.id),
			opened.deleteProposal(proposal.id),
		]);
		expect(applied).toEqual({
			proposalId: proposal.id,
			admittedChanges: 2,
		});
		expect(await Bun.file(proposal.path).exists()).toBe(false);
		expect(opened.replica.visible(NOTE_ADDRESS)).toEqual({
			state: 'live',
			payload: { title: 'After' },
		});
		expect(
			opened.replica.visible({ ...NOTE_ADDRESS, recordKey: createdId }),
		).toEqual({ state: 'live', payload: { title: 'Created' } });
		expect(opened.replica.workSummary().scalar.pending).toBe(2);
	} finally {
		await opened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner resumes a lagging Proposal watermark after restart', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-resume-'));
	let proposalId = '';
	let proposalPath = '';
	const first = await openBunRecordOwner({ directory });
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		const proposal = await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
		proposalId = proposal.id;
		proposalPath = proposal.path;
		const editable = new Database(proposal.path, { strict: true });
		try {
			editable.run(`UPDATE notes SET title = 'After' WHERE id = ?`, [
				NOTE_ADDRESS.recordKey,
			]);
		} finally {
			editable.close();
		}
		await first.compileProposal(proposal.id);
		const hmacKey = new Uint8Array(
			await readFile(join(directory, 'proposals', '.proposal-hmac-key')),
		);
		const artifact = new Database(proposal.path, { strict: true });
		try {
			const manifest = readProposalManifest({
				database: createBunSqliteAdapter(artifact),
				hmacKey,
			});
			const entry = manifest.entries[0];
			if (entry === undefined)
				throw new Error('Proposal fixture has no change');
			const write = ordinaryWrite(entry);
			first.replica.admitFencedLocalWrite({
				sourceFence: {
					replicaId: manifest.sourceReplicaId,
					authorityLifetime: manifest.sourceAuthorityLifetime,
				},
				...write,
			});
			// Simulate a crash after live admission but before watermark advancement.
			expect(manifest.appliedCount).toBe(0);
		} finally {
			artifact.close();
		}
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}

	const reopened = await openBunRecordOwner({ directory });
	try {
		expect(await reopened.applyProposal(proposalId)).toEqual({
			proposalId,
			admittedChanges: 1,
		});
		expect(await Bun.file(proposalPath).exists()).toBe(false);
		expect(reopened.replica.visible(NOTE_ADDRESS)).toEqual({
			state: 'live',
			payload: { title: 'After' },
		});
	} finally {
		await reopened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner reaps an artifact whose final deletion was interrupted', async () => {
	const directory = await mkdtemp(
		join(tmpdir(), 'epicenter-proposal-cleanup-'),
	);
	let proposalPath = '';
	const first = await openBunRecordOwner({ directory });
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		const proposal = await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
		proposalPath = proposal.path;
		const editable = new Database(proposal.path, { strict: true });
		try {
			editable.run(`UPDATE notes SET title = 'After' WHERE id = ?`, [
				NOTE_ADDRESS.recordKey,
			]);
		} finally {
			editable.close();
		}
		await first.compileProposal(proposal.id);
		const hmacKey = new Uint8Array(
			await readFile(join(directory, 'proposals', '.proposal-hmac-key')),
		);
		const artifact = new Database(proposal.path, { strict: true });
		const database = createBunSqliteAdapter(artifact);
		try {
			const manifest = readProposalManifest({ database, hmacKey });
			for (const [index, entry] of manifest.entries.entries()) {
				first.replica.admitFencedLocalWrite({
					sourceFence: {
						replicaId: manifest.sourceReplicaId,
						authorityLifetime: manifest.sourceAuthorityLifetime,
					},
					...ordinaryWrite(entry),
				});
				advanceProposalWatermark({
					database,
					hmacKey,
					fromAppliedCount: index,
				});
			}
		} finally {
			artifact.close();
		}
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}
	const reopened = await openBunRecordOwner({ directory });
	try {
		expect(await Bun.file(proposalPath).exists()).toBe(false);
		expect(await reopened.proposals()).toEqual([]);
	} finally {
		await reopened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner preserves source-fenced refusals for explicit deletion', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-fence-'));
	let proposalId = '';
	let proposalPath = '';
	const first = await openBunRecordOwner({ directory });
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		const proposal = await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
		proposalId = proposal.id;
		proposalPath = proposal.path;
		const editable = new Database(proposal.path, { strict: true });
		try {
			editable.run(`UPDATE notes SET title = 'After' WHERE id = ?`, [
				NOTE_ADDRESS.recordKey,
			]);
		} finally {
			editable.close();
		}
		await first.compileProposal(proposal.id);
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}

	const replicaFile = new Database(join(directory, 'epicenter.sqlite3'), {
		strict: true,
	});
	try {
		replicaFile.run(
			`UPDATE meta SET replica_id = 'zzzzzzzzzzzzzzzzzzzzzzzz'
			WHERE singleton = 1`,
		);
	} finally {
		replicaFile.close();
	}
	const reminted = await openBunRecordOwner({ directory });
	try {
		await expect(reminted.applyProposal(proposalId)).rejects.toThrow(
			/source fence/,
		);
		expect(await Bun.file(proposalPath).exists()).toBe(true);
		expect(await reminted.proposals()).toEqual([
			expect.objectContaining({
				id: proposalId,
				state: 'compiled',
				appliedCount: 0,
			}),
		]);
		await reminted.deleteProposal(proposalId);
		expect(await reminted.proposals()).toEqual([]);
	} finally {
		await reminted.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner never replaces a missing Proposal trust root', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-key-'));
	const first = await openBunRecordOwner({ directory });
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}
	await rm(join(directory, 'proposals', '.proposal-hmac-key'));
	try {
		await expect(openBunRecordOwner({ directory })).rejects.toThrow(
			/HMAC key is missing/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner refuses to sign beside artifacts rejected by a replaced key', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-rekey-'));
	const first = await openBunRecordOwner({ directory });
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}
	await writeFile(
		join(directory, 'proposals', '.proposal-hmac-key'),
		new Uint8Array(32).fill(99),
	);
	const replaced = await openBunRecordOwner({ directory });
	try {
		expect(await replaced.proposals()).toEqual([
			expect.objectContaining({ state: 'invalid' }),
		]);
		await expect(
			replaced.createProposal({
				lens: notesLens(),
				selection: existingNoteSelection(),
			}),
		).rejects.toThrow(/must be deleted/);
	} finally {
		await replaced.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner recovers an atomically quarantined Proposal', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-claim-'));
	let proposalId = '';
	let proposalPath = '';
	let claimDirectory = '';
	let claimPath = '';
	const first = await openBunRecordOwner({ directory });
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		const proposal = await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
		proposalId = proposal.id;
		proposalPath = proposal.path;
		claimDirectory = await mkdtemp(
			join(directory, 'proposals', `.proposal-${proposal.id}-`),
		);
		claimPath = join(claimDirectory, 'artifact.sqlite3');
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}
	await rename(proposalPath, claimPath);
	const recovered = await openBunRecordOwner({ directory });
	try {
		expect(await Bun.file(proposalPath).exists()).toBe(true);
		expect(await Bun.file(claimDirectory).exists()).toBe(false);
		expect(await recovered.proposals()).toHaveLength(1);
	} finally {
		await recovered.owner[Symbol.asyncDispose]();
	}

	claimDirectory = await mkdtemp(
		join(directory, 'proposals', `.proposal-${proposalId}-`),
	);
	claimPath = join(claimDirectory, 'artifact.sqlite3');
	await writeFile(claimPath, 'replacement');
	try {
		await expect(openBunRecordOwner({ directory })).rejects.toThrow(
			/conflicting canonical and claimed files/,
		);
		expect(await Bun.file(proposalPath).exists()).toBe(true);
		expect(await Bun.file(claimPath).exists()).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner holds exclusive Proposal directory ownership for its lifetime', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-owner-'));
	const first = await openBunRecordOwner({ directory });
	try {
		await expect(openBunRecordOwner({ directory })).rejects.toThrow(
			/owned by another live process/,
		);
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}
	const reopened = await openBunRecordOwner({ directory });
	try {
		expect(await reopened.proposals()).toEqual([]);
	} finally {
		await reopened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner drains admitted Proposal operations before releasing ownership', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-drain-'));
	const first = await openBunRecordOwner({ directory });
	let proposalId = '';
	try {
		first.replica.localWrite({
			address: NOTE_ADDRESS,
			op: 'replace',
			value: { title: 'Before' },
		});
		const proposal = await first.createProposal({
			lens: notesLens(),
			selection: existingNoteSelection(),
		});
		proposalId = proposal.id;
		const artifact = new Database(proposal.path, { strict: true });
		try {
			artifact.run(`UPDATE notes SET title = 'After' WHERE id = ?`, [
				NOTE_ADDRESS.recordKey,
			]);
		} finally {
			artifact.close();
		}
		const compilation = first.compileProposal(proposal.id);
		const application = first.applyProposal(proposal.id);
		const disposal = first.owner[Symbol.asyncDispose]();
		const [compiled, applied] = await Promise.all([
			compilation,
			application,
			disposal,
		]);
		expect(compiled).toMatchObject({ state: 'compiled', changeCount: 1 });
		expect(applied).toEqual({
			proposalId: proposal.id,
			admittedChanges: 1,
		});
		await expect(first.proposals()).rejects.toThrow(/disposed/);
	} finally {
		await first.owner[Symbol.asyncDispose]();
	}

	const reopened = await openBunRecordOwner({ directory });
	try {
		expect(await reopened.proposals()).toEqual([]);
		expect(reopened.replica.visible(NOTE_ADDRESS)).toEqual({
			state: 'live',
			payload: { title: 'After' },
		});
		expect(proposalId).not.toBe('');
	} finally {
		await reopened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});

test('Bun owner reaps an empty quarantine left after artifact deletion', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-proposal-empty-'));
	const first = await openBunRecordOwner({ directory });
	await first.owner[Symbol.asyncDispose]();
	const claimDirectory = await mkdtemp(
		join(directory, 'proposals', '.proposal-aaaaaaaaaaaaaaaaaaaaaaaa-'),
	);
	const reopened = await openBunRecordOwner({ directory });
	try {
		expect(await Bun.file(claimDirectory).exists()).toBe(false);
		expect(await reopened.proposals()).toEqual([]);
	} finally {
		await reopened.owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});
