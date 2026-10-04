/**
 * Skills Data Tests
 *
 * Exercises the real package definitions through the Bun Data runtime.
 * The tests prove release-local nonconformance, explicit typed repair,
 * row documents and honest filesystem ids.
 *
 * Key behaviors:
 * - a stricter release surfaces old canonical JSON until an explicit patch repairs it
 * - row documents persist under their owning structural row ids
 * - agentskills.io metadata ids round-trip as payload source ids
 */

import { expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTable, type RowDocument } from '@epicenter/data';
import { openBunEpicenter } from '@epicenter/data/bun';
import { field, InstantString } from '@epicenter/field';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { exportSkillsToDisk, importSkillsFromDisk } from './node.js';
import { getSkill, listSkills, scanSkills } from './services.js';
import { skillsDefinitions } from './workspace.js';

const historicalSkillsTable = defineTable({
	namespace: 'so.epicenter.skills',
	table: 'skills',
	fields: {
		name: field.string(),
		description: field.string(),
		updatedAt: field.instant(),
	},
});

test('a stricter Skills lens exposes nonconformance until typed update repairs it', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-skills-'));
	const path = join(storageRoot, 'epicenter.sqlite3');
	try {
		const historicalEpicenter = await openBunEpicenter({ path });
		const historical = historicalEpicenter.bind({
			tables: { skills: historicalSkillsTable },
			values: {},
		});
		const oldSkill = await historical.tables.skills.create({
			name: 'writing-voice',
			description: 'Write directly',
			updatedAt: InstantString.now(),
		});
		await historicalEpicenter[Symbol.asyncDispose]();

		await using epicenter = await openBunEpicenter({ path });
		const skills = epicenter.bind(skillsDefinitions);
		expect(await getSkill(skills, 'aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
			skill: undefined,
			instructions: undefined,
			nonconforming: [],
		});
		const error = expectErr(await skills.tables.skills.get(oldSkill.id));
		expect(error.name).toBe('NonconformingRow');
		if (error.name !== 'NonconformingRow') throw new Error(error.message);
		expect(error.issues).toContainEqual({
			field: 'sourceId',
			kind: 'missing',
			message: "Missing required field 'sourceId'",
		});
		const catalogBeforeRepair = await listSkills(skills);
		expect(catalogBeforeRepair.skills).toEqual([]);
		expect(catalogBeforeRepair.nonconforming.map(({ id }) => id)).toEqual([
			oldSkill.id,
		]);

		const repaired = expectOk(
			await skills.tables.skills.update(oldSkill.id, {
				sourceId: 'agentskills-writing-voice',
			}),
		);
		expect(repaired?.id).toBe(oldSkill.id);
		expect((await scanSkills(skills)).nonconforming).toEqual([]);
		await using instructions = await skills.tables.skills.openDocument(
			oldSkill.id,
		);
		writeDocumentText(instructions, 'Keep the answer concise.');
		const another = await skills.tables.skills.create({
			sourceId: 'agentskills-other',
			name: 'other',
			description: 'Another skill',
			updatedAt: InstantString.now(),
		});
		await using otherInstructions = await skills.tables.skills.openDocument(
			another.id,
		);
		expect(otherInstructions.get('content').toString()).toBe('');
		expect(instructions.get('content').toString()).toBe(
			'Keep the answer concise.',
		);
	} finally {
		rmSync(storageRoot, { recursive: true, force: true });
	}
});

function writeDocumentText(document: RowDocument, value: string): void {
	const content = document.get('content');
	document.transact(() => {
		content.delete(0, content.length);
		content.insert(0, value);
	});
}

test('filesystem import stores metadata id as sourceId instead of structural id', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-skills-io-'));
	const storageRoot = join(root, 'storage');
	const inputRoot = join(root, 'input');
	const outputRoot = join(root, 'output');
	try {
		mkdirSync(storageRoot, { recursive: true });
		const skillRoot = join(inputRoot, 'writing-voice');
		mkdirSync(join(skillRoot, 'references'), { recursive: true });
		writeFileSync(
			join(skillRoot, 'SKILL.md'),
			'---\ndescription: Write directly\nmetadata:\n  id: portable-writing-voice\n---\n\nUse plain language.\n',
		);
		writeFileSync(join(skillRoot, 'references', 'examples.md'), '# Examples\n');
		await using epicenter = await openBunEpicenter({
			path: join(storageRoot, 'epicenter.sqlite3'),
		});
		const skills = epicenter.bind(skillsDefinitions);
		const imported = await importSkillsFromDisk({
			data: skills,
			dir: inputRoot,
		});
		expect(imported.created).toBe(1);
		expect(imported.nonconforming).toEqual([]);
		const [skill] = (await scanSkills(skills)).skills;
		expect(skill?.sourceId).toBe('portable-writing-voice');
		expect(skill?.id).not.toBe('portable-writing-voice');

		const exported = await exportSkillsToDisk({
			data: skills,
			dir: outputRoot,
		});
		expect(exported).toMatchObject({ exported: 1, nonconforming: [] });
		const markdown = readFileSync(
			join(outputRoot, 'writing-voice', 'SKILL.md'),
			'utf8',
		);
		expect(markdown).toContain('id: portable-writing-voice');
		expect(markdown).toContain('Use plain language.');
		expect(
			readFileSync(
				join(outputRoot, 'writing-voice', 'references', 'examples.md'),
				'utf8',
			),
		).toBe('# Examples\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
