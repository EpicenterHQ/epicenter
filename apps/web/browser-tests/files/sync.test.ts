/**
 * Files Sync Browser Tests
 *
 * Files in the built shell, in Chromium and WebKit: two persistent profiles
 * as two people, each joining one synced repository by its link and
 * syncing it through the repository's development server as themselves.
 * Each engine works in a folder of its own, since both reach one server.
 *
 * Key behaviors:
 * - A file Alice creates and types reaches Bob's Files and the server; a reload restores the open file, or folder, from the URL
 * - Alice's rename (a delete and a write) and delete reach Bob and the server
 * - The repository's owner page, `/team`, lists it
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Page, webkit } from 'playwright';
import { HOSTNAMES, OWNER, opened, startWorld, TIMEOUT, until, type World } from '../support.js';

let world: World;
beforeAll(async () => {
	world = await startWorld(['alice', 'bob']);
}, 180_000);
afterAll(() => world?.stop());

const folder = (page: Page) => page.getByRole('region', { name: 'Folder' });
const file = (page: Page) => page.getByRole('region', { name: 'File' });
const editorOf = (page: Page, name: string) => page.getByRole('textbox', { name: `Text of ${name}` });

for (const [engine, browser] of [
	['chromium', chromium],
	['webkit', webkit],
] as const) {
	describe(engine, () => {
		test(
			'a file created, typed, renamed and deleted in Files reaches the other profile and the server',
			async () => {
				const alice = await world.open(browser, 'alice', 'files');
				const bob = await world.open(browser, 'bob', 'files');
				const dir = `plans-${engine}`;
				try {
					await opened(alice.page, 'files');
					const form = folder(alice.page).getByRole('form', { name: 'New file' });
					await form.getByRole('textbox').fill(`${dir}/trip.md`);
					await form.getByRole('button', { name: 'Create' }).click();
					await alice.page.waitForURL((url) => url.pathname.endsWith(`/${HOSTNAMES.files}/${dir}/trip.md`));
					await editorOf(alice.page, 'trip.md').click();
					await alice.page.keyboard.type('Go north');
					await until(async () => (await world.read(`${dir}/trip.md`)) === 'Go north', 'the typing on the server');

					// Bob finds it by its folder, and reads what Alice typed.
					await folder(bob.page).locator(`[data-folder="${dir}"]`).click();
					await folder(bob.page).locator(`[data-file="${dir}/trip.md"]`).click();
					await until(async () => (await editorOf(bob.page, 'trip.md').innerText()) === 'Go north', "alice's text for bob");
					// A reload opens the same file from the URL alone.
					await bob.page.reload();
					await until(async () => (await editorOf(bob.page, 'trip.md').innerText()) === 'Go north', 'the file after a reload');

					// A rename is a delete and a write.
					await file(alice.page).getByRole('button', { name: 'Rename' }).click();
					const rename = file(alice.page).getByRole('form', { name: 'Rename' });
					await rename.getByRole('textbox').fill(`${dir}/journey.md`);
					await rename.getByRole('button', { name: 'Save' }).click();
					await alice.page.waitForURL((url) => url.pathname.endsWith(`/${dir}/journey.md`));
					await until(async () => (await world.read(`${dir}/journey.md`)) === 'Go north' && (await world.read(`${dir}/trip.md`)) === null, 'the rename on the server');
					await file(bob.page).getByText(`No file is at ${dir}/trip.md`).waitFor({ timeout: 20_000 });
					await folder(bob.page).locator(`[data-file="${dir}/journey.md"]`).click();
					await until(async () => (await editorOf(bob.page, 'journey.md').innerText()) === 'Go north', 'the renamed file for bob');

					// A delete asks first, and returns to the folder.
					await file(alice.page).getByRole('button', { name: 'Delete' }).click();
					await alice.page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
					await alice.page.waitForURL((url) => url.pathname.endsWith(`/${HOSTNAMES.files}/${dir}/`));
					await until(async () => (await world.read(`${dir}/journey.md`)) === null, 'the delete on the server');
					await file(bob.page).getByText(`No file is at ${dir}/journey.md`).waitFor({ timeout: 20_000 });
					await expect(folder(bob.page).locator(`[data-file="${dir}/journey.md"]`).count()).resolves.toBe(0);
					// A reload of a folder's address opens that folder.
					await alice.page.reload();
					await folder(alice.page).getByText('No files here yet').waitFor();
					await expect(folder(alice.page).getByRole('list').getAttribute('aria-label')).resolves.toBe(`In ${dir}`);

					// The owner's page lists the repository this browser has of theirs.
					await bob.page.goto(world.url('bob', `/${OWNER}`));
					await bob.page.getByRole('heading', { name: OWNER, exact: true }).waitFor();
					await bob.page.getByRole('list', { name: `Repositories of ${OWNER}` }).getByRole('link', { name: world.address.slice(OWNER.length + 2) }).waitFor();
				} finally {
					await alice.cleanup();
					await bob.cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
