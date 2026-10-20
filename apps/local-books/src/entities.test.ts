/** The entity registry rejects unknown names, including inherited object keys. */
import { expect, test } from 'bun:test';
import { entityDef, isKnownEntity } from './entities.js';

test.each([
	'constructor',
	'toString',
	'__proto__',
	'hasOwnProperty',
	'MissingEntity',
])('%s is not a declared QuickBooks entity', (name) => {
	expect(isKnownEntity(name)).toBe(false);
	expect(() => entityDef(name)).toThrow(`Unknown QuickBooks entity "${name}"`);
});
