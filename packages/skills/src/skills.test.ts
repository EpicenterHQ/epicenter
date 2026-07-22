/**
 * Skills Data Tests
 *
 * Exercises the real package Lens through the Bun record runtime. The tests
 * prove typed records, row documents, and honest filesystem ids.
 *
 * Key behaviors:
 * - Skills records use runtime-minted structural ids
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
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import type { RowDocument } from '@epicenter/data/record';
import { InstantString } from '@epicenter/field';
import { skillsLens } from './lens.js';
import { exportSkillsToDisk, importSkillsFromDisk } from './node.js';
import { getSkill, listSkills, scanSkills } from './services.js';

test('Skills Lens stores independent row documents under structural record keys', async () => {
	const storageRoot = mkdtempSync(join(tmpdir(), 'epicenter-skills-'));
	try {
		await using epicenter = await openBunRecordEpicenter({
			directory: storageRoot,
		});
		const skills = epicenter.bind({ skills: skillsLens }).skills;
		expect(await getSkill(skills, 'aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({
			skill: undefined,
			instructions: undefined,
			nonconforming: [],
		});
		const skill = await skills.skills.create({
			sourceId: 'agentskills-writing-voice',
			name: 'writing-voice',
			description: 'Write directly',
			updatedAt: InstantString.now(),
		});
		expect(skill.id).not.toBe(skill.sourceId);
		expect((await scanSkills(skills)).nonconforming).toEqual([]);
		expect((await listSkills(skills)).skills).toEqual([
			{
				id: skill.id,
				name: 'writing-voice',
				description: 'Write directly',
			},
		]);
		await using instructions = await skills.skills.openDocument(skill.id);
		writeDocumentText(instructions, 'Keep the answer concise.');
		const another = await skills.skills.create({
			sourceId: 'agentskills-other',
			name: 'other',
			description: 'Another skill',
			updatedAt: InstantString.now(),
		});
		await using otherInstructions = await skills.skills.openDocument(
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
		await using epicenter = await openBunRecordEpicenter({
			directory: storageRoot,
		});
		const skills = epicenter.bind({ skills: skillsLens }).skills;
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
