import { InstantString } from '@epicenter/app/field';
import type { NonconformingRow } from '@epicenter/app/store';
import type { Reference, Skill, SkillsData } from '@epicenter/skills';

export type SkillMetadataUpdate = Partial<
	Pick<Skill, 'name' | 'description' | 'license' | 'compatibility'>
>;

/**
 * Skills' rows, read straight out of the store.
 *
 * There is no `refresh`, no generation counter, and no `await` on a read. The
 * store's `subscribe` says which rows a commit touched and fires for a local
 * write and for markdown typed into a row's content node alike (ADR-0221), so a
 * re-read after a mutation is something this module hears about rather than
 * something every call site remembers. That is also what retired the
 * generation counter: it existed to discard a stale async scan, and a
 * synchronous read has no window to be stale in.
 */
export function createSkillsState({ data }: { data: SkillsData }) {
	let skillRows = $state.raw<Skill[]>([]);
	let referenceRows = $state.raw<Reference[]>([]);
	let nonconforming = $state.raw<NonconformingRow[]>([]);
	let selectedSkillId = $state<string | null>(null);

	function read(): void {
		const skills = data.tables.skills;
		const references = data.tables.skillReferences;
		skillRows = skills.rows;
		referenceRows = references.rows;
		nonconforming = [...skills.nonconforming, ...references.nonconforming];
	}

	read();
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187).
	const stopSkills = data.tables.skills.subscribe(read);
	const stopReferences = data.tables.skillReferences.subscribe(read);

	const sortedSkills = $derived(
		skillRows.toSorted((left, right) => left.name.localeCompare(right.name)),
	);
	const selectedSkill = $derived(
		selectedSkillId
			? (skillRows.find((skill) => skill.id === selectedSkillId) ?? null)
			: null,
	);
	const selectedReferences = $derived(
		selectedSkillId
			? referenceRows
					.filter((reference) => reference.skillId === selectedSkillId)
					.toSorted((left, right) => left.path.localeCompare(right.path))
			: [],
	);

	return {
		get skills() {
			return sortedSkills;
		},
		get selectedSkillId() {
			return selectedSkillId;
		},
		get selectedSkill() {
			return selectedSkill;
		},
		get selectedReferences() {
			return selectedReferences;
		},
		get nonconforming() {
			return nonconforming;
		},
		selectSkill(id: string | null) {
			selectedSkillId = id;
		},

		/** Apply a change, or throw so the caller's toast can present it. */
		createSkill(name: string): string {
			const skill = data.tables.skills.create({
				sourceId: crypto.randomUUID(),
				name,
				description: 'TODO: describe when and why to use this skill.',
				license: null,
				compatibility: null,
				metadata: null,
				allowedTools: null,
				updatedAt: InstantString.now(),
			});
			selectedSkillId = skill.id;
			return skill.id;
		},

		updateSkill(id: string, updates: SkillMetadataUpdate): void {
			const { error } = data.tables.skills.update(id, {
				...updates,
				updatedAt: InstantString.now(),
			});
			if (error !== null) throw error;
		},

		deleteSkill(id: string): void {
			for (const reference of referenceRows) {
				if (reference.skillId !== id) continue;
				data.tables.skillReferences.delete(reference.id);
			}
			data.tables.skills.delete(id);
			if (selectedSkillId === id) {
				selectedSkillId =
					sortedSkills.find((skill) => skill.id !== id)?.id ?? null;
			}
		},

		createReference(skillId: string, path: string): string {
			const reference = data.tables.skillReferences.create({
				skillId,
				path,
				updatedAt: InstantString.now(),
			});
			return reference.id;
		},

		deleteReference(id: string): void {
			data.tables.skillReferences.delete(id);
		},

		[Symbol.dispose]() {
			stopSkills();
			stopReferences();
		},
	};
}
