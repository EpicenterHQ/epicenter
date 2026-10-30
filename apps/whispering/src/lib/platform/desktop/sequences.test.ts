/**
 * Delete sequences over the desktop opener.
 *
 * The real whispering runs over the folder mirror the desktop page opens
 * (`@epicenter/folder/tauri`), in a directory the shell grants
 * (`granted-shell.test-support.ts` in the folder package). That is where a
 * save can be held while another is asked for, and where a reply can be lost
 * after the change landed.
 *
 * Key behaviors:
 * - a deletion asked for while a save of the row is out runs after it, and
 *   removes the file that save wrote
 * - a deletion whose reply was lost is reported, and the folder shows the
 *   file gone once it looks again
 *
 * See also:
 * - `services.test.ts` for the services over the shell and the host
 * - `../../workflows.test.ts` for editing over a directory this process opens
 */
import '../../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { svelteFolder } from '@epicenter/svelte/folder';
import { expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type DataChange,
	type GrantedShell,
	grantedDirectory,
} from '../../../../../../packages/folder/src/granted-shell.test-support.js';
import { whisperingTables } from '../../definition.js';
import {
	deferred,
	eventually,
	openTestServices,
} from '../../services.test-support.js';
import {
	closeTestWhispering,
	createTestWhispering,
} from '../../whispering.test-support.js';

let shell: GrantedShell;
mock.module('@tauri-apps/api/core', () => ({
	SERIALIZE_TO_IPC_FN: '__TAURI_TO_IPC_KEY__',
	Channel: class {},
	transformCallback: () => 0,
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));
// The shell's watcher: these tests change the directory only through the page.
mock.module('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({ listen: async () => () => {} }),
}));

const { openFolder } = await import('@epicenter/folder/tauri');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ID = 'clean';
const PATH = `transformations/${ID}.md`;
const SEED = '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n';

/** Whispering over the desktop opener, in a granted directory holding `files`. */
async function open(files: Record<string, string>) {
	const root = await grantedDirectory();
	shell = createGrantedShell(root);
	for (const [path, text] of Object.entries(files))
		await shell.write(path, text);
	const stubs = await openTestServices();
	const opened = expectOk(await openFolder({ tables: whisperingTables }));
	const folder = svelteFolder(opened);
	const { whispering } = await createTestWhispering({
		services: stubs.services,
		folder,
	});
	cleanups.push(async () => {
		closeTestWhispering({ whispering, folder });
		await opened.close();
		await stubs.remove();
		await rm(root, { recursive: true, force: true });
	});
	await whispering.start();
	// The sequence below starts after app initialization has saved its exclusions.
	shell.changes.length = 0;
	whispering.open(PATH);
	return { whispering, folder };
}

/** Hold the next data change of `kind` until `release`; `reached` when it arrives. */
function holdNext(kind: DataChange['kind']) {
	const reached = deferred<void>();
	const held = deferred<void>();
	shell.control.beforeChange = async (change) => {
		if (change.kind !== kind) return;
		shell.control.beforeChange = undefined;
		reached.resolve();
		await held.promise;
	};
	return { reached: reached.promise, release: () => held.resolve() };
}

test('a deletion asked for while the row saves runs after it, and removes what it saved', async () => {
	const { whispering, folder } = await open({ [PATH]: SEED });
	const save = holdNext('write');
	const saving = folder.tables.transformations.update(ID, {
		body: 'Saved first.\n',
	});
	await save.reached;

	const deletion = expectOk(await whispering.deletionFor(PATH));
	const deleting = whispering.delete(deletion);
	save.release();
	expectOk(await saving);

	expect(await deleting).toBeUndefined();
	expect(shell.kinds).toEqual(['write', 'remove']);
	expect(await shell.text(PATH)).toBeUndefined();
	expect(whispering.selectedTransformation).toBeUndefined();
});

test('a deletion whose reply was lost is reported, and the folder shows the file gone once it looks again', async () => {
	const { whispering, folder } = await open({ [PATH]: SEED });
	const deletion = expectOk(await whispering.deletionFor(PATH));
	shell.control.loseReplies = 1;

	// Nothing said the removal landed, so it is not reported done.
	expect(await whispering.delete(deletion)).toBeTruthy();
	expect(shell.kinds).toEqual(['remove']);
	expect(await shell.text(PATH)).toBeUndefined();
	folder.refresh();
	await eventually(() => folder.file(PATH) === undefined);
	expect(whispering.selectedTransformation?.path).toBe(PATH);
});
