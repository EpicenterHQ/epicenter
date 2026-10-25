import '../../../../packages/svelte/node_modules/fake-indexeddb/auto/index.mjs';
import { openFolder } from '@epicenter/folder/next/browser';
import { createFolder, memoryHost } from '@epicenter/folder/next/testing';
import { expectOk } from 'wellcrafted/testing';
import { type VocabFolder, type VocabTables, vocabTables } from './data.js';

export async function until(done: () => boolean, what: string) {
	for (let attempt = 0; attempt < 1500; attempt++) {
		if (done()) return;
		await Bun.sleep(2);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

export async function settle(conversation: {
	snapshot(): { isGenerating: boolean; isSaving: boolean };
}) {
	while (
		conversation.snapshot().isGenerating ||
		conversation.snapshot().isSaving
	)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

export function createBrowser() {
	const indexedDB = new IDBFactory();
	const opened: { close(): Promise<void> }[] = [];
	return {
		async open(): Promise<VocabFolder> {
			const { svelteFolder } = await import('@epicenter/svelte/folder-next');
			globalThis.indexedDB = indexedDB;
			const core = expectOk(
				await openFolder({ tables: vocabTables }),
			);
			opened.push(core);
			return svelteFolder(core);
		},
		async [Symbol.asyncDispose]() {
			for (const core of opened.splice(0)) await core.close();
		},
	};
}

export async function createMemory(
	initial: Record<string, string | Uint8Array> = {},
) {
	const { svelteFolder } = await import('@epicenter/svelte/folder-next');
	const host = memoryHost(initial);
	const core = expectOk(
		await createFolder(host.storage, { tables: vocabTables }),
	);
	return { folder: svelteFolder(core), core, host };
}

export function fileText(
	folder: VocabFolder,
	path: string,
): string | undefined {
	const data = folder.file(path)?.data;
	return typeof data === 'string' ? data : undefined;
}

export function tableFiles(
	folder: VocabFolder,
	table: keyof VocabTables,
): string[] {
	return folder.files
		.map((file) => file.path)
		.filter((path) => path.startsWith(`${table}/`));
}

export async function put(folder: VocabFolder, path: string, text: string) {
	expectOk(await folder.write(path, text));
}
