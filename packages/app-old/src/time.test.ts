/** `timeId` names a record by the moment it was made, sorting in that order. */
import { expect, test } from 'bun:test';
import { timeId } from './time.ts';

test('timeId preserves the UTC ISO stamp and adds exactly eight lowercase base36 characters', () => {
	const at = new Date('2026-11-16T09:12:04.120Z');
	const ids = Array.from({ length: 100 }, () => timeId(at));
	expect(
		ids.every((id) => /^2026-11-16T09-12-04-120Z-[a-z0-9]{8}$/.test(id)),
	).toBe(true);
	expect(new Set(ids).size).toBe(100);
	expect(
		ids.every((id) => timeId(new Date('2026-11-16T09:12:04.121Z')) > id),
	).toBe(true);
});
