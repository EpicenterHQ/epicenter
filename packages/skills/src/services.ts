import type {
	NonconformingRowError,
	RecordNotLiveError,
	RowDocument,
} from '@epicenter/data/runtime';
import type { Result } from 'wellcrafted/result';
import type { Reference, Skill, SkillsData } from './lens.js';

export type SkillsScan = {
	skills: Skill[];
	nonconforming: NonconformingRowError[];
};

export type ReferencesScan = {
	references: Reference[];
	nonconforming: NonconformingRowError[];
};

/** Read the complete skill traversal and surface nonconforming rows. */
export async function scanSkills(data: SkillsData): Promise<SkillsScan> {
	const { rows: skills, nonconforming } = await data.skills.scan();
	return { skills, nonconforming };
}

/** Read the complete reference traversal and surface nonconforming rows. */
export async function scanReferences(
	data: SkillsData,
): Promise<ReferencesScan> {
	const { rows: references, nonconforming } = await data.references.scan();
	return { references, nonconforming };
}

/** Build the sorted catalog while preserving nonconforming diagnostics. */
export async function listSkills(data: SkillsData) {
	const { skills, nonconforming } = await scanSkills(data);
	return {
		skills: skills
			.map(({ id, name, description }) => ({ id, name, description }))
			.sort((left, right) => left.name.localeCompare(right.name)),
		nonconforming,
	};
}

/** Read one skill and lazily hydrate its row-owned instruction document. */
export async function getSkill(data: SkillsData, id: string) {
	const result = await data.skills.record(id).get();
	if (result.error !== null) {
		return {
			skill: undefined,
			instructions: undefined,
			nonconforming: [result.error],
		};
	}
	if (result.data === undefined) {
		return { skill: undefined, instructions: undefined, nonconforming: [] };
	}
	await using instructions = await openDocument(
		data.skills.record(id).document,
	);
	return {
		skill: result.data,
		instructions: instructions.get('content').toString(),
		nonconforming: [],
	};
}

/** Read a skill, its instructions, and every conforming reference body. */
export async function getSkillWithReferences(data: SkillsData, id: string) {
	const skill = await getSkill(data, id);
	if (skill.skill === undefined) {
		return { ...skill, references: [] };
	}
	const scanned = await scanReferences(data);
	const references = await Promise.all(
		scanned.references
			.filter((reference) => reference.skillId === id)
			.map(async (reference) => {
				await using content = await openDocument(
					data.references.record(reference.id).document,
				);
				return {
					path: reference.path,
					content: content.get('content').toString(),
				};
			}),
	);
	return {
		...skill,
		references: references.sort((left, right) =>
			left.path.localeCompare(right.path),
		),
		nonconforming: [...skill.nonconforming, ...scanned.nonconforming],
	};
}

async function openDocument(document: {
	open(): Promise<Result<RowDocument, RecordNotLiveError>>;
}): Promise<RowDocument> {
	const { data, error } = await document.open();
	if (error !== null) throw error;
	return data;
}
