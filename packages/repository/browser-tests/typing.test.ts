/**
 * Typing Tests: the deciding tests for typing whose one home is the worker
 *
 * A person types at speed into one note's editor (CodeMirror, through the
 * repository API's page) in Chromium and WebKit, with the worker's answers
 * held and another profile editing the same line meanwhile, and leaves the
 * page right after typing (a reload, a freeze, a pagehide). Typing is safe
 * once it reaches the worker; only a keystroke in the instant before the
 * page goes may be lost.
 *
 * Key behaviors:
 * - 200 keystrokes at 10 ms, a write held and a same-line edit elsewhere landing midway: every keystroke, in order, in exactly one conflict block, and the cursor stays where the person types
 * - Typing inside the very characters another person changed, while a write is in flight, is saved as one conflict block: nothing waits for the person to choose
 * - A reload right after typing loses at most the last keystrokes, never one in the middle, with the worker's answers held or not
 * - A freeze or a pagehide right after typing loses nothing, and typing carries on after
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page, webkit } from 'playwright';
import { openDiskRepository, serveRepository } from '../src/bun/serve.js';
import { authenticateBearer } from '../src/wire/wire.js';
import { startSite } from './site.js';
import { launchProfile, loadApiPage, TIMEOUT } from './support.js';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => {
	site = await startSite();
});
afterAll(() => site.stop());

const typed = (count: number, from = 0) =>
	Array.from(
		{ length: count },
		(_, i) => 'abcdefghijklmnopqrstuvwxyz'[(from + i) % 26],
	).join('');
const blocks = (text: string) => text.match(/^<<<<<<< /gm)?.length ?? 0;

/** Open `stem` in the editor, with the cursor at the end of the line `line` (from 0) of its body. */
async function editAtEndOf(page: Page, stem: string, line: number) {
	await page
		.locator(`[data-testid="todo"][data-stem="${stem}"]`)
		.getByRole('button')
		.click();
	const content = page.locator('.cm-content');
	await content.waitFor();
	await content.locator('.cm-line').nth(line).click();
	await page.keyboard.press('End');
}

/** A server, and a profile per person with the repository open on the API page. */
async function startWorld(browser: typeof chromium, people: readonly string[]) {
	const dir = await mkdtemp(join(tmpdir(), 'typing-'));
	const server = await openDiskRepository(join(dir, 'repo.git'));
	const repository = `typing-${crypto.randomUUID().slice(0, 8)}`;
	const served = serveRepository({
		repository,
		serverId: 'typing',
		server,
		authenticate: authenticateBearer((token) => ({
			user: token,
			role: 'writer',
		})),
		origins: [new URL(site.url).origin],
	});
	const profiles: { context: BrowserContext; cleanup(): Promise<void> }[] = [];
	const pages: Record<string, { page: Page; replica: string }> = {};
	for (const person of people) {
		const profile = await launchProfile(browser);
		profiles.push(profile);
		const page = await loadApiPage(profile.context, site.url, {
			page: profile.context.pages()[0],
		});
		const replica = await page.evaluate(
			([repository, url, person]) =>
				api.create(repository, { account: person, url, token: person }),
			[repository, served.url, person] as const,
		);
		await page.evaluate(() => api.untilOpen());
		pages[person] = { page, replica };
	}
	return {
		server,
		pages,
		async stop() {
			for (const profile of profiles) await profile.cleanup();
			await served.stop();
			await server.flush();
			await server.idle();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'200 keystrokes at 10 ms, a write held and a same-line edit elsewhere landing midway: every keystroke, in order, in one conflict block, the cursor kept',
			async () => {
				const world = await startWorld(browser, ['alice', 'bob']);
				try {
					const { page: alice } = world.pages.alice!;
					const { page: bob } = world.pages.bob!;
					expect(
						await alice.evaluate(() =>
							api.add('plan', 'Plan', 'first\nsecond\nthird'),
						),
					).toBeNull();
					await bob.evaluate(() =>
						api.untilBody('plan', 'first\nsecond\nthird'),
					);
					await editAtEndOf(alice, 'plan', 1);

					await alice.evaluate(() => api.hold());
					await alice.keyboard.type(typed(100), { delay: 10 });
					// Bob changes the same line; it reaches Alice's worker while her answers are held.
					expect(
						await bob.evaluate(() =>
							api.writeBody(
								'plan',
								'first\nSECOND\nthird',
								'first\nsecond\nthird',
							),
						),
					).toBeNull();
					await alice.evaluate(() => api.untilStored('plan', 'SECOND'));
					await alice.keyboard.type(typed(100, 100), { delay: 10 });
					await alice.evaluate(() => api.release());
					// The cursor is still where Alice typed: one more keystroke lands right after the others.
					await alice.keyboard.type('Z');

					const all = `second${typed(200)}Z`;
					await alice.waitForFunction(
						(all) =>
							api.editorDraft()?.includes(all) === true &&
							api.editorState() === 'saved',
						all,
						{ timeout: 20_000 },
					);
					const stored = (await alice.evaluate(() => api.stored('plan'))) ?? '';
					expect(blocks(stored)).toBe(1);
					expect(stored).toContain(`\n${all}\n`);
					expect(stored).toContain('\nSECOND\n');
					expect(await alice.evaluate(() => api.editorDraft())).toBe(
						stored.slice(stored.indexOf('---\n', 4) + 4),
					);
					// The server ends with the same text.
					const deadline = Date.now() + 10_000;
					while (
						world.server.read('todos/plan.md') !== stored &&
						Date.now() < deadline
					)
						await Bun.sleep(50);
					expect(world.server.read('todos/plan.md')).toBe(stored);
				} finally {
					await world.stop();
				}
			},
			TIMEOUT,
		);

		test(
			'typing inside the characters another person changed, while a write is in flight, is saved as one conflict block',
			async () => {
				const world = await startWorld(browser, ['alice', 'bob']);
				try {
					const { page: alice } = world.pages.alice!;
					const { page: bob } = world.pages.bob!;
					expect(
						await alice.evaluate(() => api.add('word', 'Word', 'alpha\nbeta')),
					).toBeNull();
					await bob.evaluate(() => api.untilBody('word', 'alpha\nbeta'));
					await editAtEndOf(alice, 'word', 0);
					// Bob's change reaches Alice's worker before her page hears of it, so her first keystroke is made over the text before it.
					await alice.evaluate(() => api.hold({ deltas: true }));
					expect(
						await bob.evaluate(() =>
							api.writeBody('word', 'alpha\nQRST', 'alpha\nbeta'),
						),
					).toBeNull();
					await alice.evaluate(() => api.untilStored('word', 'QRST'));
					await alice.keyboard.type('X', { delay: 10 });
					await alice.evaluate(() => api.untilStored('word', 'alphaX'));
					// Inside the word Bob changed, in what Alice still sees.
					await alice.keyboard.press('ArrowDown');
					await alice.keyboard.press('Home');
					await alice.keyboard.press('ArrowRight');
					await alice.keyboard.press('ArrowRight');
					await alice.keyboard.type('Y', { delay: 10 });
					await alice.evaluate(() => api.release());
					await alice.waitForFunction(
						() => api.editorState() === 'saved',
						undefined,
						{ timeout: 20_000 },
					);
					const stored = (await alice.evaluate(() => api.stored('word'))) ?? '';
					expect(blocks(stored)).toBe(1);
					expect(stored).toContain('alphaX');
					expect(stored).toContain('\nQRST\n');
					expect(stored).toContain('beYta');
					expect(await alice.evaluate(() => api.editorDraft())).toBe(
						stored.slice(stored.indexOf('---\n', 4) + 4),
					);
				} finally {
					await world.stop();
				}
			},
			TIMEOUT,
		);

		test(
			'a reload right after typing loses at most the last keystrokes, never one in the middle',
			async () => {
				const world = await startWorld(browser, ['alice']);
				try {
					const { page, replica } = world.pages.alice!;
					const lost: number[] = [];
					for (let round = 0; round < 6; round++) {
						const stem = `r${round}`;
						expect(
							await page.evaluate((stem) => api.add(stem, stem, 'start'), stem),
						).toBeNull();
						await editAtEndOf(page, stem, 0);
						// Every other round, the worker's answers are held: the page has many writes unanswered as it goes.
						if (round % 2 === 1) await page.evaluate(() => api.hold());
						const text = typed(60, round);
						await page.keyboard.type(text, { delay: 10 });
						await page.reload();
						await page.waitForFunction(() => globalThis.api !== undefined);
						await page.evaluate(
							(replica) => api.open(replica, 'alice'),
							replica,
						);
						await page.evaluate(() => api.untilOpen());
						const body =
							(await page.evaluate(() => api.todos())).find(
								(todo) => todo.stem === stem,
							)?.body ?? '';
						// What is kept is everything up to some keystroke: nothing dropped from the middle, nothing out of order.
						expect(body.startsWith('start')).toBe(true);
						expect(text.startsWith(body.slice('start'.length))).toBe(true);
						lost.push(text.length - (body.length - 'start'.length));
					}
					console.log(
						`${engine}: keystrokes lost by a reload right after typing, per round: ${lost.join(', ')}`,
					);
					for (const count of lost) expect(count).toBeLessThanOrEqual(3);
				} finally {
					await world.stop();
				}
			},
			TIMEOUT,
		);

		test(
			'a freeze or a pagehide right after typing loses nothing, and typing carries on after',
			async () => {
				const world = await startWorld(browser, ['alice']);
				try {
					const { page } = world.pages.alice!;
					for (const [leave, back] of [
						['freeze', 'resume'],
						['pagehide', 'pageshow'],
					] as const) {
						const stem = leave;
						expect(
							await page.evaluate((stem) => api.add(stem, stem, 'start'), stem),
						).toBeNull();
						await editAtEndOf(page, stem, 0);
						const text = typed(60);
						await page.keyboard.type(text, { delay: 10 });
						await page.evaluate((leave) => api[leave](), leave);
						await page.evaluate(() => api.untilStatus('opening'));
						await page.evaluate((back) => api[back](), back);
						await page.evaluate(() => api.untilOpen());
						await page.evaluate(([stem, all]) => api.untilStored(stem, all), [
							stem,
							`start${text}`,
						] as const);
						await page.keyboard.type('!');
						await page.evaluate(() => api.untilEditorSaved());
						expect(
							await page.evaluate((stem) => api.stored(stem), stem),
						).toEndWith(`---\nstart${text}!`);
					}
				} finally {
					await world.stop();
				}
			},
			TIMEOUT,
		);
	});
}
