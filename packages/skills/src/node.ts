/** Filesystem import and export over caller-bound Skills data. */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordNotLiveError, RowDocument } from '@epicenter/data/runtime';
import { InstantString } from '@epicenter/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Reference, Skill, SkillsData } from './lens.js';
import { parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';
import { scanReferences, scanSkills } from './services.js';

export const SkillsIoError = defineErrors({
	ScanDirectoryFailed: ({ dir, cause }: { dir: string; cause: unknown }) => ({
		message: `Failed to scan directory '${dir}': ${extractErrorMessage(cause)}`,
		dir,
		cause,
	}),
});
export type SkillsIoError = InferErrors<typeof SkillsIoError>;

/**
 * Import agentskills.io folders into canonical records and row documents.
 * Frontmatter ids are portable `sourceId` payloads, never caller-selected
 * structural record ids.
 */
export async function importSkillsFromDisk({
	data,
	dir,
}: {
	data: SkillsData;
	dir: string;
}) {
	const entries = await readdir(dir, { withFileTypes: true });
	const reads = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const skillPath = join(dir, entry.name);
				try {
					const raw = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
					return { skillPath, ...parseSkillMd(entry.name, raw) };
				} catch (cause) {
					if (isNotFound(cause)) return null;
					throw cause;
				}
			}),
	);
	const skillsScan = await scanSkills(data);
	const referencesScan = await scanReferences(data);
	const skillsBySourceId = new Map<string, { id: string }>(
		skillsScan.skills.map((skill) => [skill.sourceId, { id: skill.id }]),
	);
	for (const error of skillsScan.nonconforming) {
		if (error.name !== 'NonconformingRow') continue;
		const sourceId = error.raw.sourceId;
		if (typeof sourceId === 'string' && !skillsBySourceId.has(sourceId)) {
			skillsBySourceId.set(sourceId, { id: error.id });
		}
	}
	const referencesByOwnerAndPath = new Map<string, { id: string }>(
		referencesScan.references.map((reference) => [
			referenceKey(reference.skillId, reference.path),
			{ id: reference.id },
		]),
	);
	for (const error of referencesScan.nonconforming) {
		if (error.name !== 'NonconformingRow') continue;
		const { skillId, path } = error.raw;
		if (typeof skillId === 'string' && typeof path === 'string') {
			const key = referenceKey(skillId, path);
			if (!referencesByOwnerAndPath.has(key)) {
				referencesByOwnerAndPath.set(key, { id: error.id });
			}
		}
	}
	const seenSourceIds = new Set<string>();
	let created = 0;
	let updated = 0;

	for (const read of reads) {
		if (read === null) continue;
		const proposedSourceId = read.skill.sourceId;
		const sourceId =
			proposedSourceId && !seenSourceIds.has(proposedSourceId)
				? proposedSourceId
				: crypto.randomUUID();
		seenSourceIds.add(sourceId);
		const input = {
			sourceId,
			name: read.skill.name,
			description: read.skill.description,
			license: read.skill.license,
			compatibility: read.skill.compatibility,
			metadata: read.skill.metadata,
			allowedTools: read.skill.allowedTools,
			updatedAt: read.skill.updatedAt,
		};
		const existing = skillsBySourceId.get(sourceId);
		let skill: Skill;
		if (existing) {
			const repaired = await data.skills.record(existing.id).update(input);
			if (repaired.error !== null || repaired.data === undefined) {
				throw new Error(
					repaired.error?.message ?? `Skill '${existing.id}' disappeared`,
				);
			}
			skill = repaired.data;
			updated += 1;
		} else {
			skill = await data.skills.create(input);
			skillsBySourceId.set(sourceId, { id: skill.id });
			created += 1;
		}

		if (sourceId !== proposedSourceId) {
			await writeFile(
				join(read.skillPath, 'SKILL.md'),
				serializeSkillMd(skill, read.instructions),
				'utf8',
			);
		}
		await using instructions = await openDocument(
			data.skills.record(skill.id).document,
		);
		writeDocumentText(instructions, read.instructions);

		const referencesPath = join(read.skillPath, 'references');
		let referenceFiles: string[] = [];
		try {
			referenceFiles = (await readdir(referencesPath)).filter((name) =>
				name.endsWith('.md'),
			);
		} catch (cause) {
			if (!isNotFound(cause)) throw cause;
		}
		await Promise.all(
			referenceFiles.map(async (path) => {
				const content = await readFile(join(referencesPath, path), 'utf8');
				const key = referenceKey(skill.id, path);
				const existingReference = referencesByOwnerAndPath.get(key);
				const reference = existingReference
					? await repairReference(data, existingReference, path)
					: await data.references.create({
							skillId: skill.id,
							path,
							updatedAt: InstantString.now(),
						});
				referencesByOwnerAndPath.set(key, reference);
				await using document = await openDocument(
					data.references.record(reference.id).document,
				);
				writeDocumentText(document, content);
			}),
		);
	}

	return {
		created,
		updated,
		nonconforming: [
			...skillsScan.nonconforming,
			...referencesScan.nonconforming,
		],
	};
}

/** Publish every conforming skill to agentskills.io folders. */
export async function exportSkillsToDisk({
	data,
	dir,
}: {
	data: SkillsData;
	dir: string;
}) {
	const skillsScan = await scanSkills(data);
	const referencesScan = await scanReferences(data);
	const skillNames = new Set(skillsScan.skills.map((skill) => skill.name));
	await Promise.all(
		skillsScan.skills.map(async (skill) => {
			const skillDir = join(dir, skill.name);
			await mkdir(skillDir, { recursive: true });
			await using instructions = await openDocument(
				data.skills.record(skill.id).document,
			);
			await writeFile(
				join(skillDir, 'SKILL.md'),
				serializeSkillMd(skill, instructions.get('content').toString()),
				'utf8',
			);
			const references = referencesScan.references.filter(
				(reference) => reference.skillId === skill.id,
			);
			if (references.length === 0) return;
			const referencesDir = join(skillDir, 'references');
			await mkdir(referencesDir, { recursive: true });
			await Promise.all(
				references.map(async (reference) => {
					await using content = await openDocument(
						data.references.record(reference.id).document,
					);
					await writeFile(
						join(referencesDir, reference.path),
						content.get('content').toString(),
						'utf8',
					);
				}),
			);
		}),
	);

	let staleNames: string[] = [];
	try {
		staleNames = (await readdir(dir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && !skillNames.has(entry.name))
			.map((entry) => entry.name);
	} catch (cause) {
		if (!isNotFound(cause)) {
			throw SkillsIoError.ScanDirectoryFailed({ dir, cause }).error;
		}
	}
	await Promise.all(
		staleNames.map((name) =>
			rm(join(dir, name), { recursive: true, force: true }),
		),
	);
	return {
		exported: skillsScan.skills.length,
		nonconforming: [
			...skillsScan.nonconforming,
			...referencesScan.nonconforming,
		],
	};
}

async function repairReference(
	data: SkillsData,
	reference: { id: string },
	path: string,
): Promise<Reference> {
	const repaired = await data.references.record(reference.id).update({
		path,
		updatedAt: InstantString.now(),
	});
	if (repaired.error !== null || repaired.data === undefined) {
		throw new Error(
			repaired.error?.message ?? `Reference '${reference.id}' disappeared`,
		);
	}
	return repaired.data;
}

async function openDocument(document: {
	open(): Promise<Result<RowDocument, RecordNotLiveError>>;
}): Promise<RowDocument> {
	const { data, error } = await document.open();
	if (error !== null) throw error;
	return data;
}

function writeDocumentText(document: RowDocument, value: string): void {
	const content = document.get('content');
	document.transact(() => {
		content.delete(0, content.length);
		content.insert(0, value);
	});
}

function referenceKey(skillId: string, path: string): string {
	return `${skillId}\u0000${path}`;
}

function isNotFound(cause: unknown): boolean {
	return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}
