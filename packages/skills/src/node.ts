/** Filesystem import and export over caller-bound Skills data. */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RowDocument } from '@epicenter/data/record';
import { InstantString } from '@epicenter/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { SkillsData } from './lens.js';
import { parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';
import { scanReferences, scanSkills } from './services.js';
import type { Reference, Skill } from './tables.js';

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
	const referencesByOwnerAndPath = new Map<string, { id: string }>(
		referencesScan.references.map((reference) => [
			referenceKey(reference.skillId, reference.path),
			{ id: reference.id },
		]),
	);
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
			const result = await data.skills.update(existing.id, input);
			if (result.error !== null || result.data === undefined) {
				throw new Error(
					result.error?.message ?? `Skill '${existing.id}' disappeared`,
				);
			}
			skill = result.data;
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
		await using instructions = await data.skills.openDocument(skill.id);
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
					? await updateReference(data, existingReference, path)
					: await data.references.create({
							skillId: skill.id,
							path,
							updatedAt: InstantString.now(),
						});
				referencesByOwnerAndPath.set(key, reference);
				await using document = await data.references.openDocument(reference.id);
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
			await using instructions = await data.skills.openDocument(skill.id);
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
					await using content = await data.references.openDocument(
						reference.id,
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

async function updateReference(
	data: SkillsData,
	reference: { id: string },
	path: string,
): Promise<Reference> {
	const result = await data.references.update(reference.id, {
		path,
		updatedAt: InstantString.now(),
	});
	if (result.error !== null || result.data === undefined) {
		throw new Error(
			result.error?.message ?? `Reference '${reference.id}' disappeared`,
		);
	}
	return result.data;
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
