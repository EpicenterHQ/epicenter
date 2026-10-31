import { expect, test } from 'bun:test';
import { readingStatementProblem } from './read-only-query.js';

test('only a statement that starts with a reading keyword may run', () => {
	expect(readingStatementProblem('-- why\n select 1')).toBeUndefined();
	expect(
		readingStatementProblem('WITH t AS (SELECT 1) SELECT * FROM t'),
	).toBeUndefined();
	expect(readingStatementProblem("ATTACH 'x.db' AS x")).toContain('not ATTACH');
	expect(readingStatementProblem(' /* nothing */ ')).toContain('empty');
});
