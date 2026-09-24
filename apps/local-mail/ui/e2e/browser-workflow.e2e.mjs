/** Production SavedQueries, App, OPFS and restricted SQL with synthetic mail; no live provider. */
import assert from 'node:assert/strict';
import { origins, test } from './fixtures.mjs';

test.use({ persistentOrigin: origins.queries });
test('saved queries, offline storage and failure recovery', async ({
	page,
}, testInfo) => {
	const observations = [];
	const errors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') console.error('browser:', message.text());
	});
	page.on('pageerror', (error) => {
		errors.push(error.message);
		console.error('page error:', error);
	});
	// Reload after saving; query switches exercise their own discard warning.
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto(origins.queries);
	await page.waitForFunction(
		'globalThis.evidence || globalThis.evidenceFailure',
		undefined,
		{ timeout: 60000 },
	);
	const failure = await page.evaluate('globalThis.evidenceFailure');
	if (failure) throw new Error(failure);
	const name = page.getByLabel('Name', { exact: true });
	const sql = page.getByLabel('SQL', { exact: true });
	const save = page.getByRole('button', { name: 'Save', exact: true });
	const run = page.getByRole('button', { name: 'Run', exact: true });
	await test.step('save text and reopen downloaded mail offline', async () => {
		await name.fill('My downloaded mail');
		await sql.fill('this is invalid SQL');
		await save.click();
		await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
		assert(
			(await page.getByRole('alert').count()) === 0,
			'Saving invalid SQL ran it',
		);
		observations.push('Saved invalid SQL without executing it');
		await page.evaluate(
			'localStorage.setItem("evidence-offline", "true"); globalThis.evidence.close()',
		);
		await page.reload();
		await page.waitForFunction(
			'globalThis.evidence || globalThis.evidenceFailure',
		);
		const reopenedFailure = await page.evaluate('globalThis.evidenceFailure');
		if (reopenedFailure) throw new Error(reopenedFailure);
		await page
			.getByRole('button', { name: 'My downloaded mail', exact: true })
			.click();
		assert(
			(await sql.inputValue()) === 'this is invalid SQL',
			'Saved SQL did not reopen offline',
		);
		observations.push(
			'Saved query and cached mail reopened with account transport offline',
		);
	});
	await test.step('isolate accounts and enforce restricted SQL', async () => {
		await sql.fill('SELECT id, subject FROM messages');
		await save.click();
		await run.click();
		await page
			.getByRole('cell', { name: 'one subject', exact: true })
			.waitFor();
		await page.getByLabel('Gmail account', { exact: true }).selectOption('two');
		assert(
			(await page.getByLabel('Query results', { exact: true }).count()) === 0,
			'Previous account result stayed visible',
		);
		await run.click();
		await page
			.getByRole('cell', { name: 'two subject', exact: true })
			.waitFor();
		observations.push(
			'Same message ID isolated across two selected Gmail accounts; switching clears previous results',
		);
		await sql.fill('DELETE FROM messages');
		await run.click();
		await page.getByText('Query failed', { exact: true }).waitFor();
		await sql.fill('SELECT subject FROM messages');
		await run.click();
		await page
			.getByRole('cell', { name: 'two subject', exact: true })
			.waitFor();
		observations.push(
			'Write query rejected and trusted cache remained readable',
		);
		await sql.fill(
			"SELECT 9223372036854775807 AS value, x'00ff' AS value, NULL AS value, snippet FROM messages",
		);
		await run.click();
		await page
			.getByRole('cell', { name: '9223372036854775807', exact: true })
			.waitFor();
		await page.getByRole('cell', { name: 'hex:00ff', exact: true }).waitFor();
		await page.getByRole('cell', { name: 'NULL', exact: true }).waitFor();
		assert(
			(await page
				.getByRole('columnheader', { name: 'value', exact: true })
				.count()) === 3,
			'Duplicate headers were lost',
		);
		assert(
			(await page.locator('[aria-label="Query results"] script').count()) === 0,
			'Result text created an executable element',
		);
		observations.push(
			'Duplicate columns, exact large integer/blob/null values, and HTML-shaped text render positionally',
		);
	});
	await test.step('preserve drafts through navigation and peer changes', async () => {
		await page.getByRole('button', { name: 'New query', exact: true }).click();
		await page.getByText('Discard this draft?', { exact: true }).waitFor();
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert(
			(await sql.inputValue()).includes('9223372036854775807'),
			'Cancel discarded the dirty draft',
		);
		observations.push(
			'Dirty navigation prompts and Cancel preserves the draft',
		);
		await page.evaluate('globalThis.evidence.remoteEdit()');
		await page
			.getByText('This query changed elsewhere', { exact: true })
			.waitFor();
		assert(
			(await sql.inputValue()).includes('9223372036854775807'),
			'Remote change overwrote the draft',
		);
		observations.push(
			'Remote stored-row change is explicit and preserves the dirty draft',
		);

		await page
			.getByRole('button', { name: 'Reload stored version', exact: true })
			.click();
		await page
			.getByRole('button', { name: 'Discard draft', exact: true })
			.click();
		assert(
			(await sql.inputValue()) === 'SELECT id FROM labels',
			'Explicit remote reload did not select stored SQL',
		);
		await sql.fill('SELECT subject FROM messages');
		await page
			.getByRole('button', { name: 'My downloaded mail', exact: true })
			.click();
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert(
			(await sql.inputValue()) === 'SELECT subject FROM messages',
			'Cancelled query switch discarded draft',
		);
		await page
			.getByRole('button', { name: 'My downloaded mail', exact: true })
			.click();
		await page
			.getByRole('button', { name: 'Discard draft', exact: true })
			.click();
		assert(
			(await sql.inputValue()) === 'SELECT id FROM labels',
			'Discard did not reopen the stored query',
		);
		observations.push(
			'Saved-query switching keeps the draft on cancel and restores stored text on discard',
		);
		await page.evaluate('globalThis.evidence.remoteEdit(true)');
		await page
			.getByText('This query changed elsewhere', { exact: true })
			.waitFor();
		await page
			.getByRole('button', { name: 'Reload stored version', exact: true })
			.click();
		assert(
			(await page
				.getByRole('button', { name: 'Delete', exact: true })
				.count()) === 0,
			'Reloading a peer-deleted query retained a missing row selection',
		);
		await name.fill('New query after peer deletion');
		await sql.fill('SELECT id FROM labels');
		await save.click();
		await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
		observations.push(
			'Explicit reload after peer deletion opens a new draft that can be saved',
		);
	});
	await test.step('repair and delete incompatible peer rows', async () => {
		const malformed = await page.evaluate('globalThis.evidence.malformed()');
		await page
			.getByRole('button', {
				name: `Repair query ${malformed.repair.slice(0, 8)}`,
				exact: true,
			})
			.click();
		await page.getByText('This query needs repair', { exact: true }).waitFor();
		await name.fill('Repaired query');
		await sql.fill('SELECT subject FROM messages');
		await save.click();
		await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
		assert(
			(await page.evaluate(
				(id) =>
					globalThis.evidence.app.personal.tables.savedQueries.get(id)?.sql,
				malformed.repair,
			)) === 'SELECT subject FROM messages',
			'Repair changed original row identity',
		);
		await page
			.getByRole('button', {
				name: `Repair query ${malformed.remove.slice(0, 8)}`,
				exact: true,
			})
			.click();
		await page.getByRole('button', { name: 'Delete', exact: true }).click();
		await page
			.getByRole('button', { name: 'Delete query', exact: true })
			.click();
		assert(
			(await page.evaluate(
				(id) =>
					globalThis.evidence.app.personal.tables.savedQueries
						.ids()
						.includes(id),
				malformed.remove,
			)) === false,
			'Malformed row deletion failed',
		);
		observations.push(
			'Malformed peer rows remain repairable under the original id and deletable',
		);
	});
	await test.step('recover durable saves and deletions after quota failures', async () => {
		await name.fill('Retry persistence');
		await sql.fill('SELECT subject FROM messages');
		await page.evaluate(
			'globalThis.restorePersistence = globalThis.evidence.blockPersistence()',
		);
		await save.click();
		await page
			.getByText('Could not save query changes', { exact: true })
			.waitFor();
		assert(
			(await sql.inputValue()) === 'SELECT subject FROM messages',
			'Persistence failure lost draft',
		);
		await page.evaluate('globalThis.restorePersistence()');
		await page
			.getByRole('button', { name: 'Retry saving', exact: true })
			.click();
		await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
		observations.push(
			'Actual IndexedDB quota failure displays unsaved status and retries retained writes after storage recovers',
		);
		await page.getByRole('button', { name: 'New query', exact: true }).click();
		await name.fill('Delete during storage failure');
		await sql.fill('SELECT id FROM messages');
		await save.click();
		await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
		await page.evaluate(
			'globalThis.restorePersistence = globalThis.evidence.blockPersistence()',
		);
		await page.getByRole('button', { name: 'Delete', exact: true }).click();
		await page
			.getByRole('button', { name: 'Delete query', exact: true })
			.click();
		await page
			.getByText('Could not save query changes', { exact: true })
			.waitFor();
		assert(
			(await name.inputValue()) === '' && (await sql.inputValue()) === '',
			'Failed deletion retained the deleted row in the editor',
		);
		assert(
			(await page
				.getByText('This query changed elsewhere', { exact: true })
				.count()) === 0,
			'Local deletion was reported as a remote conflict',
		);
		await page.evaluate('globalThis.restorePersistence()');
		await page
			.getByRole('button', { name: 'Retry saving', exact: true })
			.click();
		await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
		assert(
			(await page
				.getByText('This query changed elsewhere', { exact: true })
				.count()) === 0,
			'Retried deletion left a stale selection',
		);
		await page.evaluate('globalThis.evidence.close()');
		await page.reload();
		await page.waitForFunction(
			'globalThis.evidence || globalThis.evidenceFailure',
		);
		assert(
			(await page
				.getByRole('button', {
					name: 'Delete during storage failure',
					exact: true,
				})
				.count()) === 0,
			'Retried deletion did not survive reopening',
		);
		await page
			.getByRole('button', { name: 'Retry persistence', exact: true })
			.click();
		observations.push(
			'Deletion during a quota failure clears selection, reports failed persistence until retry, and remains deleted after reopen',
		);
	});
	await test.step('cancel account-bound runs and reopen without transient results', async () => {
		await page.getByLabel('Gmail account', { exact: true }).selectOption('two');
		await sql.fill(
			'WITH RECURSIVE numbers(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM numbers WHERE x<100000000) SELECT sum(x) FROM numbers',
		);
		await run.click();
		await page
			.getByRole('button', { name: 'Cancel run', exact: true })
			.waitFor();
		await page.getByLabel('Gmail account', { exact: true }).selectOption('one');
		// A bounded late-result observation, not proof that the worker has stopped.
		// The Cancel run button disappears before the underlying query settles.
		await page.waitForTimeout(500);
		assert(
			(await page.getByLabel('Query results', { exact: true }).count()) === 0,
			'Late result appeared under another account',
		);
		await sql.fill('SELECT subject FROM messages');
		await save.click();
		await run.click();
		await page
			.getByRole('cell', { name: 'one subject', exact: true })
			.waitFor();
		observations.push(
			'Account switch cancels a production worker query and suppresses late results; subsequent queries recover',
		);
		await page.evaluate('globalThis.evidence.close()');
		await page.reload();
		await page.waitForFunction(
			'globalThis.evidence || globalThis.evidenceFailure',
		);
		await page
			.getByRole('button', { name: 'Retry persistence', exact: true })
			.click();
		assert(
			(await page.getByLabel('Query results', { exact: true }).count()) === 0,
			'Transient results survived document reopen',
		);
		assert(
			(await sql.inputValue()) === 'SELECT subject FROM messages',
			'Retried save did not persist through reopen',
		);
		await run.click();
		await page
			.getByRole('cell', { name: 'one subject', exact: true })
			.waitFor();
		observations.push(
			'Retried saved text and original cache survive another offline reopen; prior results are transient and require Run again',
		);
	});
	assert(errors.length === 0, `Uncaught browser errors: ${errors.join('; ')}`);
	await testInfo.attach('query-evidence', {
		body: JSON.stringify({ observations }),
		contentType: 'application/json',
	});
	await page.evaluate('globalThis.evidence.close()');
});
