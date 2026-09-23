import { expect, test } from 'bun:test';
import { vocabDefinition, vocabLocalDefinition } from './data.js';

test('chat is device-owned while saved entries are account-owned', () => {
	expect(vocabLocalDefinition.id).toBe(vocabDefinition.id);
	expect(Object.keys(vocabLocalDefinition.tables).sort()).toEqual([
		'conversations',
		'messages',
	]);
	expect(Object.keys(vocabLocalDefinition.kv)).toEqual(['showReadings']);
	expect(Object.keys(vocabDefinition.tables)).toEqual(['entries']);
	expect(Object.keys(vocabDefinition.kv)).toEqual([]);
});
