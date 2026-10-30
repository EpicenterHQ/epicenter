/**
 * Repository API Browser Tests
 *
 * A small Svelte page on the repository API (`api-harness.ts`): Todos kept
 * in memory and listed with a toggle each, and the selected todo's body in
 * the repository's source editor (CodeMirror), over this tab's replica.
 * Two persistent profiles sync through the Bun dev server.
 *
 * Key behaviors:
 * - The list reads from memory, and a toggle shows at once and reaches the other profile
 * - The other profile's edit arriving while a keystroke's write is in flight is carried in place: the cursor stays where the person types, and Undo takes back only their typing
 * - A reload opens the same notes; a freeze lets the replica go and takes it up again without remounting the page, keeping what was typed meanwhile
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { authenticateBearer } from '../src/wire/wire.js';
import { startSite } from './site.js';
import { launchProfile, loadApiPage, TIMEOUT } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			"a page on the repository API: the list from memory, a toggle, another profile's edit arriving mid-typing, a reload and a freeze",
			async () => {
				const dir = await mkdtemp(join(tmpdir(), 'api-browser-'));
				const server = await openDiskRepository(join(dir, 'repo.git'));
				const repository = `todos-${crypto.randomUUID().slice(0, 8)}`;
				const served = serveRepository({
					repository,
					serverId: 'api-browser',
					server,
					authenticate: authenticateBearer((token) => ({
						user: token,
						role: 'writer',
					})),
					origins: [new URL(site.url).origin],
				});
				const alice = await launchProfile(browser);
				const bob = await launchProfile(browser);
				try {
					const a = await loadApiPage(alice.context, site.url, {
						page: alice.context.pages()[0],
					});
					const b = await loadApiPage(bob.context, site.url, {
						page: bob.context.pages()[0],
					});
					const replica = await a.evaluate(
						([repository, url]) =>
							api.create(repository, { account: 'alice', url, token: 'alice' }),
						[repository, served.url] as const,
					);
					await b.evaluate(
						([repository, url]) =>
							api.create(repository, { account: 'bob', url, token: 'bob' }),
						[repository, served.url] as const,
					);
					await a.evaluate(() => api.untilOpen());
					await b.evaluate(() => api.untilOpen());

					// The list, from memory; a toggle shows at once and reaches Bob.
					expect(
						await a.evaluate(() =>
							api.add('plan', 'Plan', 'first\nsecond\nthird'),
						),
					).toBeNull();
					await b.evaluate(() => api.untilBody('plan', 'first\nsecond\nthird'));
					const row = a.locator('[data-testid="todo"][data-stem="plan"]');
					await row.locator('input[type="checkbox"]').click();
					expect(await row.locator('input[type="checkbox"]').isChecked()).toBe(
						true,
					);
					await b.waitForFunction(() =>
						api.todos().some((todo) => todo.stem === 'plan' && todo.done),
					);

					// Alice edits the body, the cursor at the end of the second line.
					await row.getByRole('button', { name: 'Plan' }).click();
					const content = a.locator('.cm-content');
					await content.waitFor();
					await content.click();
					await a.keyboard.press('ControlOrMeta+Home');
					await a.keyboard.press('ArrowDown');
					await a.keyboard.press('End');
					await a.evaluate(() => api.hold());
					await a.keyboard.type('X');
					// Bob changes the first and third lines while Alice's write is in flight.
					expect(
						await b.evaluate(() =>
							api.writeBody(
								'plan',
								'FIRST\nsecond\nTHIRD',
								'first\nsecond\nthird',
							),
						),
					).toBeNull();
					await a.evaluate(() => api.untilStored('plan', 'FIRST'));
					await a.keyboard.type('YZ');
					// Nothing of Bob's has reached the editor: it was dirty, with a write in flight.
					expect(
						await a.evaluate(() => [api.replacements(), api.editorDraft()]),
					).toEqual([0, 'first\nsecondXYZ\nthird']);
					await a.evaluate(() => api.release());
					await a.waitForFunction(
						() => api.editorDraft() === 'FIRST\nsecondXYZ\nTHIRD',
					);
					// Carried onto the worker's merged text in place, once.
					expect(await a.evaluate(() => api.replacements())).toBe(1);
					await a.evaluate(() => api.untilEditorSaved());
					expect(await content.innerText()).toBe('FIRST\nsecondXYZ\nTHIRD');
					// The cursor stayed where Alice was typing.
					await a.keyboard.type('W');
					await a.waitForFunction(
						() => api.editorDraft() === 'FIRST\nsecondXYZW\nTHIRD',
					);
					// Undo takes back Alice's typing, never Bob's lines.
					for (
						let step = 0;
						step < 4 &&
						(await a.evaluate(() => api.editorDraft())) !==
							'FIRST\nsecond\nTHIRD';
						step++
					) {
						await a.keyboard.press('ControlOrMeta+z');
						expect(await a.evaluate(() => api.editorDraft())).toMatch(
							/^FIRST\nsecond.*\nTHIRD$/,
						);
					}
					expect(await a.evaluate(() => api.editorDraft())).toBe(
						'FIRST\nsecond\nTHIRD',
					);
					await a.keyboard.type(' done');
					await a.evaluate(() => api.untilEditorSaved());
					expect(await a.evaluate(() => api.stored('plan'))).toContain(
						'FIRST\nsecond done\nTHIRD',
					);
					await b.evaluate(() =>
						api.untilBody('plan', 'FIRST\nsecond done\nTHIRD'),
					);

					// A freeze lets the replica go and takes it up again: the page is not mounted again, and typing meanwhile is kept.
					await row.evaluate((element) => {
						(element as unknown as { marked: boolean }).marked = true;
					});
					await a.evaluate(() => api.freeze());
					await a.evaluate(() => api.untilStatus('opening'));
					expect(
						await a.evaluate(() => api.todos().map((todo) => todo.stem)),
					).toEqual(['plan']);
					await a.keyboard.type('!');
					await a.evaluate(() => api.resume());
					await a.evaluate(() => api.untilOpen());
					await a.evaluate(() => api.untilEditorSaved());
					expect(await a.evaluate(() => api.mounts())).toBe(1);
					expect(
						await row.evaluate(
							(element) => (element as unknown as { marked?: boolean }).marked,
						),
					).toBe(true);
					expect(await a.evaluate(() => api.stored('plan'))).toContain(
						'FIRST\nsecond done!\nTHIRD',
					);

					// A reload opens the same notes.
					await a.reload();
					await a.waitForFunction(() => globalThis.api !== undefined);
					await a.evaluate((replica) => api.open(replica, 'alice'), replica);
					await a.evaluate(() => api.untilOpen());
					expect(await a.evaluate(() => api.todos())).toMatchObject([
						{ stem: 'plan', done: true, body: 'FIRST\nsecond done!\nTHIRD' },
					]);
					await b.evaluate(() =>
						api.untilBody('plan', 'FIRST\nsecond done!\nTHIRD'),
					);
				} finally {
					await alice.cleanup();
					await bob.cleanup();
					await served.stop();
					await rm(dir, { recursive: true, force: true });
				}
			},
			TIMEOUT,
		);
	});
}
