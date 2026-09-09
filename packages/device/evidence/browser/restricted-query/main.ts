/** Production OPFS worker evidence; fixtures contain synthetic data only. */
import { createBrowserSqliteOwner } from '../../../src/browser.js';
import { expectOk } from 'wellcrafted/testing';
import { QUERY_LIMITS } from '../../../src/query.js';

const observations: Record<string, unknown> = {};
const failures: string[] = [];
function check(name: string, condition: boolean, value?: unknown) {
	observations[name] = value ?? condition;
	if (!condition) failures.push(name);
}

try {
	const owner = createBrowserSqliteOwner();
	const lifetime = await owner.acquire('so.epicenter.query-evidence', {
		library: 'local',
	});
	const db = await lifetime.open('queries');
	expectOk(
		await db.batch([
			{ sql: 'CREATE TABLE messages(id TEXT, labels TEXT)' },
			{ sql: `INSERT INTO messages VALUES ('synthetic', '["UNREAD"]')` },
			{ sql: 'CREATE TABLE private_intents(id TEXT)' },
		]),
	);
	const options = { tables: ['messages', 'labels'] };
	for (const [name, sql] of Object.entries({
		select: 'SELECT id FROM messages',
		count: 'SELECT count(*) FROM messages',
		json: 'SELECT value FROM messages, json_each(messages.labels)',
		jsonTree: 'SELECT value FROM json_tree(\'{"x":1}\')',
		cte: 'WITH x AS (SELECT id FROM messages) SELECT * FROM x',
		cteCount: 'WITH x AS (SELECT id FROM messages) SELECT count(*) FROM x',
		zero: 'SELECT id FROM messages WHERE 0',
		duplicates: 'SELECT 1 AS value, 2 AS value',
		quotedSemicolon: "SELECT ';' AS value; -- trailing comment",
		quotedIdentifiers: 'SELECT "id" FROM "messages"',
		tags: "SELECT 9223372036854775807 AS integer, 1.25 AS real, X'00ff' AS blob, NULL AS missing",
		textNul: "SELECT 'a'||char(0)||'b' AS value",
		excessiveRows:
			'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<1100) SELECT n FROM x',
		excessiveBytes:
			'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<20) SELECT zeroblob(100000) FROM x',
	})) {
		const result = await db.query(sql, options);
		check(name, result.error === null, result);
	}
	for (const [name, sql] of Object.entries({
		multiple: 'SELECT 1; SELECT 2',
		write: 'DELETE FROM messages RETURNING id',
		insert: "INSERT INTO messages VALUES ('forbidden', '[]') RETURNING id",
		create: 'CREATE TABLE escape(id)',
		attach: "ATTACH ':memory:' AS escaped",
		pragma: 'PRAGMA database_list',
		pragmaFunction: "SELECT * FROM pragma_table_info('messages')",
		pragmaCount: "SELECT count(*) FROM pragma_table_info('messages')",
		begin: 'BEGIN',
		commit: 'COMMIT',
		savepoint: 'SAVEPOINT escaped',
		privateTable: 'SELECT * FROM private_intents',
		privateCount: 'SELECT count(*) FROM private_intents',
		schema: 'SELECT * FROM sqlite_master',
		schemaCount: 'SELECT count(*) FROM sqlite_schema',
		loadExtension: "SELECT load_extension('none')",
		unknownFunction: 'SELECT sqlite_version()',
		excessiveWork:
			'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x',
		excessiveValue: `SELECT zeroblob(${QUERY_LIMITS.valueBytes + 1})`,
		excessiveSql: `SELECT 1 ${' '.repeat(QUERY_LIMITS.sqlBytes)}`,
		excessiveColumns: `SELECT ${Array.from({ length: QUERY_LIMITS.columns + 1 }, () => '1').join(',')}`,
		malformedTail: 'SELECT 1; nonsense',
		nul: 'SELECT 1\0; SELECT 2',
		empty: '-- no statement',
		nonfinite: 'SELECT 1e999',
	})) {
		const result = await db.query(sql, options);
		check(name, result.error !== null, result);
		const recovery = await db.run(
			'UPDATE messages SET labels = \'["UNREAD"]\'',
		);
		check(`${name}:recovery`, recovery.error === null, recovery);
	}
	const parameterResult = await db.query('SELECT ?, ?, ?, ?', {
		...options,
		parameters: [42, 'a\0b', new Uint8Array([0, 255]), null],
	});
	if (parameterResult.error !== null) throw parameterResult.error.cause;
	const parameters = parameterResult.data;
	check(
		'parameters',
		JSON.stringify(parameters.rows) ===
			'[[{"integer":"42"},"a\\u0000b",{"blob":"00ff"},null]]',
		parameters,
	);
	check(
		'missingParameters',
		(await db.query('SELECT ?', options)).error !== null,
	);
	check(
		'extraParameters',
		(await db.query('SELECT 1', { ...options, parameters: [1] })).error !==
			null,
	);
	const aborted = new AbortController();
	aborted.abort();
	check(
		'alreadyAborted',
		(await db.query('SELECT 1', { ...options, signal: aborted.signal }))
			.error !== null,
	);
	const controller = new AbortController();
	const pending = db.query(
		'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<1000) SELECT n FROM x',
		{ ...options, signal: controller.signal },
	);
	setTimeout(() => controller.abort(), 20);
	check('abortDuringRows', (await pending).error !== null);
	check(
		'abortRecovery',
		(await db.run("INSERT INTO messages VALUES ('after', '[]')")).error ===
			null,
	);
	const final = expectOk(
		await db.query('SELECT count(*) AS total FROM messages', options),
	);
	check(
		'recoveryCount',
		JSON.stringify(final.rows) === '[[{"integer":"2"}]]',
		final,
	);
	const otherLifetime = await owner.acquire('so.epicenter.query-other', {
		library: 'local',
	});
	const other = await otherLifetime.open('queries');
	expectOk(await other.run('CREATE TABLE private_rows(id INTEGER)'));
	const firstQuery = db.query(
		'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<500) SELECT n FROM x',
		options,
	);
	const trustedOtherWrite = other.run('INSERT INTO private_rows VALUES (7)');
	const otherQuery = other.query(
		'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<500) SELECT n, id FROM x, private_rows',
		{ tables: ['private_rows'] },
	);
	const [firstResult, writeResult, otherResult] = await Promise.all([
		firstQuery,
		trustedOtherWrite,
		otherQuery,
	]);
	check(
		'concurrentFirst',
		firstResult.error === null && firstResult.data.rows.length === 500,
	);
	check('concurrentTrustedWrite', writeResult.error === null);
	check(
		'concurrentOther',
		otherResult.error === null && otherResult.data.rows.length === 500,
	);
	check(
		'concurrentRecovery',
		(await other.run('DELETE FROM private_rows')).error === null,
	);
	await otherLifetime.close();
	const overhead = JSON.stringify({
		columns: ['value'],
		rows: [['']],
		truncated: false,
	}).length;
	const exactBytes = expectOk(
		await db.query('SELECT ? AS value', {
			...options,
			parameters: ['x'.repeat(QUERY_LIMITS.resultBytes - overhead)],
		}),
	);
	check(
		'exactResultBytes',
		!exactBytes.truncated &&
			new TextEncoder().encode(JSON.stringify(exactBytes)).length ===
				QUERY_LIMITS.resultBytes,
	);
	const exceededBytes = expectOk(
		await db.query('SELECT ? AS value', {
			...options,
			parameters: ['x'.repeat(QUERY_LIMITS.resultBytes - overhead + 1)],
		}),
	);
	check(
		'exceededResultBytes',
		exceededBytes.truncated && exceededBytes.rows.length === 0,
	);
	expectOk(
		await db.run(
			`CREATE TABLE wide(${Array.from({ length: 128 }, (_, index) => '"' + 'x'.repeat(9000) + index + '" TEXT').join(',')})`,
		),
	);
	check(
		'oversizedMetadata',
		(await db.query('SELECT * FROM wide', { tables: ['wide'] })).error !== null,
	);
	expectOk(await db.run('DROP TABLE wide'));
	// The shared connection must refuse TEMP/ATTACH even after trusted code uses them.
	expectOk(await db.run('CREATE TEMP TABLE messages(id TEXT)'));
	check(
		'tempShadow',
		(await db.query('SELECT count(*) FROM temp.messages', options)).error !==
			null,
	);
	check(
		'tempRead',
		(await db.query('SELECT id FROM temp.messages', options)).error !== null,
	);
	expectOk(await db.run("ATTACH ':memory:' AS other"));
	expectOk(await db.run('CREATE TABLE other.messages(id TEXT)'));
	check(
		'attachedShadow',
		(await db.query('SELECT count(*) FROM other.messages', options)).error !==
			null,
	);
	expectOk(await db.run('DETACH other'));
	expectOk(await db.run('DROP TABLE temp.messages'));
	check(
		'policyRestored',
		(await db.query('SELECT count(*) FROM main.messages', options)).error ===
			null,
	);
	expectOk(await db.run('CREATE TABLE main.json_each(secret TEXT)'));
	check(
		'physicalJsonTable',
		(await db.query('SELECT secret FROM main.json_each', options)).error !==
			null,
	);
	check(
		'physicalJsonCount',
		(await db.query('SELECT count(*) FROM main.json_each', options)).error !==
			null,
	);
	await lifetime.close();
	const reopened = await owner.acquire('so.epicenter.query-evidence', {
		library: 'local',
	});
	const reopenedDb = await reopened.open('queries');
	check(
		'reopenPhysicalJson',
		(await reopenedDb.query('SELECT secret FROM main.json_each', options))
			.error !== null,
	);
	check(
		'reopenTrustedRecovery',
		(await reopenedDb.run('DROP TABLE main.json_each')).error === null,
	);
	check(
		'reopenJsonModule',
		(await reopenedDb.query("SELECT value FROM json_each('[1]')", options))
			.error === null,
	);
	await reopened.close();
	Object.assign(globalThis, { evidence: { observations, failures } });
} catch (error) {
	Object.assign(globalThis, {
		evidence: { failure: String(error), observations, failures },
	});
}
