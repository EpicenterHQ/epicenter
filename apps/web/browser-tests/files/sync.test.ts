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
 * - Alice's PNG bytes reach Bob and decode in his image view
 * - The repository's owner page, `/team`, lists it
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { chromium, type Page, webkit } from 'playwright';
import {
	HOSTNAMES,
	OWNER,
	opened,
	startWorld,
	TIMEOUT,
	until,
	type World,
} from '../support.js';

let world: World;
beforeAll(async () => {
	world = await startWorld(['alice', 'bob']);
}, 180_000);
afterAll(() => world?.stop());

const folder = (page: Page) => page.getByRole('region', { name: 'Folder' });
const file = (page: Page) => page.getByRole('region', { name: 'File' });
const editorOf = (page: Page, name: string) =>
	page.getByRole('textbox', { name: `Text of ${name}` });

/** A one-pixel red RGBA PNG, with valid chunk CRCs and compressed scanline. */
function png() {
	function chunk(type: string, data: Buffer) {
		const kind = Buffer.from(type);
		const crcInput = Buffer.concat([kind, data]);
		let crc = 0xffffffff;
		for (const byte of crcInput) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++)
				crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		const result = Buffer.alloc(12 + data.length);
		result.writeUInt32BE(data.length, 0);
		kind.copy(result, 4);
		data.copy(result, 8);
		result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
		return result;
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

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
					const form = folder(alice.page).getByRole('form', {
						name: 'New file',
					});
					await form.getByRole('textbox').fill(`${dir}/trip.md`);
					await form.getByRole('button', { name: 'Create' }).click();
					await alice.page.waitForURL((url) =>
						url.pathname.endsWith(`/${HOSTNAMES.files}/${dir}/trip.md`),
					);
					await editorOf(alice.page, 'trip.md').click();
					await alice.page.keyboard.type('Go north');
					await until(
						async () => (await world.read(`${dir}/trip.md`)) === 'Go north',
						'the typing on the server',
					);

					// Bob finds it by its folder, and reads what Alice typed.
					await folder(bob.page).locator(`[data-folder="${dir}"]`).click();
					await folder(bob.page)
						.locator(`[data-file="${dir}/trip.md"]`)
						.click();
					await until(
						async () =>
							(await editorOf(bob.page, 'trip.md').innerText()) === 'Go north',
						"alice's text for bob",
					);
					// A reload opens the same file from the URL alone.
					await bob.page.reload();
					await until(
						async () =>
							(await editorOf(bob.page, 'trip.md').innerText()) === 'Go north',
						'the file after a reload',
					);

					// A rename is a delete and a write.
					await file(alice.page)
						.getByRole('button', { name: 'Rename' })
						.click();
					const rename = file(alice.page).getByRole('form', { name: 'Rename' });
					await rename.getByRole('textbox').fill(`${dir}/journey.md`);
					await rename.getByRole('button', { name: 'Save' }).click();
					await alice.page.waitForURL((url) =>
						url.pathname.endsWith(`/${dir}/journey.md`),
					);
					await until(
						async () =>
							(await world.read(`${dir}/journey.md`)) === 'Go north' &&
							(await world.read(`${dir}/trip.md`)) === null,
						'the rename on the server',
					);
					await file(bob.page)
						.getByText(`No file is at ${dir}/trip.md`)
						.waitFor({ timeout: 20_000 });
					await folder(bob.page)
						.locator(`[data-file="${dir}/journey.md"]`)
						.click();
					await until(
						async () =>
							(await editorOf(bob.page, 'journey.md').innerText()) ===
							'Go north',
						'the renamed file for bob',
					);

					// A delete asks first, and returns to the folder.
					await file(alice.page)
						.getByRole('button', { name: 'Delete' })
						.click();
					await alice.page
						.getByRole('alertdialog')
						.getByRole('button', { name: 'Delete' })
						.click();
					await alice.page.waitForURL((url) =>
						url.pathname.endsWith(`/${HOSTNAMES.files}/${dir}/`),
					);
					await until(
						async () => (await world.read(`${dir}/journey.md`)) === null,
						'the delete on the server',
					);
					await file(bob.page)
						.getByText(`No file is at ${dir}/journey.md`)
						.waitFor({ timeout: 20_000 });
					await expect(
						folder(bob.page).locator(`[data-file="${dir}/journey.md"]`).count(),
					).resolves.toBe(0);
					// A reload of a folder's address opens that folder.
					await alice.page.reload();
					await folder(alice.page).getByText('No files here yet').waitFor();
					await expect(
						folder(alice.page).getByRole('list').getAttribute('aria-label'),
					).resolves.toBe(`In ${dir}`);

					// The owner's page lists the repository this browser has of theirs.
					await bob.page.goto(world.url('bob', `/${OWNER}`));
					await bob.page
						.getByRole('heading', { name: OWNER, exact: true })
						.waitFor();
					await bob.page
						.getByRole('list', { name: `Repositories of ${OWNER}` })
						.getByRole('link', { name: world.address.slice(OWNER.length + 2) })
						.waitFor();
				} finally {
					await alice.cleanup();
					await bob.cleanup();
				}
			},
			TIMEOUT,
		);

		test(
			'a PNG added in one profile opens as an image in the other',
			async () => {
				const alice = await world.open(browser, 'alice', 'files');
				const bob = await world.open(browser, 'bob', 'files');
				const dir = `pictures-${engine}`;
				try {
					const form = folder(alice.page).getByRole('form', {
						name: 'New file',
					});
					await form.getByRole('textbox').fill(`${dir}/index.md`);
					await form.getByRole('button', { name: 'Create' }).click();
					await alice.page.waitForURL((url) =>
						url.pathname.endsWith(`/${dir}/index.md`),
					);
					await folder(alice.page)
						.getByLabel('Choose file to add')
						.setInputFiles({
							name: 'pixel.png',
							mimeType: 'image/png',
							buffer: png(),
						});
					await alice.page.waitForURL((url) =>
						url.pathname.endsWith(`/${dir}/pixel.png`),
					);
					await file(alice.page)
						.getByRole('img', { name: 'pixel.png' })
						.waitFor();
					await folder(bob.page).locator(`[data-folder="${dir}"]`).click();
					await folder(bob.page)
						.locator(`[data-file="${dir}/pixel.png"]`)
						.click();
					const image = file(bob.page).getByRole('img', { name: 'pixel.png' });
					await image.waitFor();
					await until(
						() =>
							image.evaluate(
								(element) => (element as HTMLImageElement).naturalWidth > 0,
							),
						'the PNG decoded for Bob',
					);
				} finally {
					await alice.cleanup();
					await bob.cleanup();
				}
			},
			TIMEOUT,
		);
	});
}
