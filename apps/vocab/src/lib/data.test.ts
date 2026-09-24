import { expect, test } from 'bun:test';
import { chatHistoryDefinition, vocabDefinition } from './data.js';

test('chat is device-owned while saved entries are account-owned', () => {
	expect(chatHistoryDefinition.id).toBe(vocabDefinition.id);
	expect(Object.keys(chatHistoryDefinition.tables)).toEqual(['messages']);
	expect(Object.keys(chatHistoryDefinition.kv)).toEqual([]);
	expect(Object.keys(vocabDefinition.tables)).toEqual(['entries']);
	expect(Object.keys(vocabDefinition.kv)).toEqual([]);
});
