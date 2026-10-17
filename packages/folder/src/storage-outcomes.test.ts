/**
 * Storage outcome vectors over the Bun directory storage.
 *
 * `fixtures/storage-outcomes.json` in `tauri-plugin-epicenter-folder` lists
 * storage calls and what each answers. `storage_tests.rs` runs the same
 * vectors over the desktop shell's storage, so a desktop page and a Bun
 * process answer each call alike.
 */
import { expect, test } from 'bun:test';
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRATCH_DIRECTORY } from './boundary.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { hashBytes } from './hash.js';

type Case = {
	readonly name: string;
	readonly requires?: 'caseInsensitive' | 'links';
	readonly tree: {
		readonly files?: Record<string, string>;
		readonly directories?: readonly string[];
		readonly links?: Record<string, string>;
	};
	readonly call: {
		readonly method: 'read' | 'put' | 'mkdir' | 'rmdir' | 'children' | 'list';
		readonly path?: string;
		readonly bytes?: string | null;
		readonly ifMatch?: string | null;
	};
	readonly expect:
		| { readonly value: unknown }
		| { readonly error: Record<string, string> };
	readonly after?: {
		readonly files?: Record<string, string>;
		readonly absent?: readonly string[];
	};
};

const vectors = JSON.parse(
	await readFile(
		join(
			import.meta.dir,
			'../../tauri-plugin-epicenter-folder/fixtures/storage-outcomes.json',
		),
		'utf8',
	),
) as { readonly cases: readonly Case[] };

const encode = (text: string) => new TextEncoder().encode(text);

/** Whether the disk under `root` finds `Probe` when asked for `probe`. */
async function ignoresCase(root: string) {
	await writeFile(join(root, 'Probe'), '');
	const ignores = await lstat(join(root, 'probe')).then(
		() => true,
		() => false,
	);
	await rm(join(root, 'Probe'));
	return ignores;
}

test.each(
	vectors.cases.map((vector) => [vector.name, vector] as const),
)('%s', async (_, vector) => {
	const temp = await realpath(await mkdtemp(join(tmpdir(), 'outcomes-')));
	try {
		const root = join(temp, 'root');
		await mkdir(join(temp, 'outside'), { recursive: true });
		await mkdir(root);
		await writeFile(join(temp, 'outside/secret.md'), 'secret');
		if (vector.requires === 'caseInsensitive' && !(await ignoresCase(root)))
			return;
		if (vector.requires === 'links' && process.platform === 'win32') return;
		for (const directory of vector.tree.directories ?? [])
			await mkdir(join(root, directory), { recursive: true });
		for (const [path, text] of Object.entries(vector.tree.files ?? {})) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), text);
		}
		for (const [path, target] of Object.entries(vector.tree.links ?? {}))
			await symlink(target, join(root, path));

		const storage = createDirectoryStorage({
			root,
			primitives: nodeDirectoryPrimitives,
		});
		const { method, path = '', bytes = null, ifMatch = null } = vector.call;
		const expected = ifMatch === null ? null : await hashBytes(encode(ifMatch));
		const answer = await (async () => {
			switch (method) {
				case 'read': {
					const read = await storage.read(path);
					return read.error === null
						? { data: { text: new TextDecoder().decode(read.data.bytes) } }
						: { error: read.error };
				}
				case 'put':
					return storage.put(
						path,
						bytes === null ? null : encode(bytes),
						expected,
					);
				case 'mkdir':
					return storage
						.mkdir(path)
						.then((made) =>
							made.error === null ? { data: null } : { error: made.error },
						);
				case 'rmdir':
					return storage
						.rmdir(path)
						.then((removed) =>
							removed.error === null
								? { data: null }
								: { error: removed.error },
						);
				case 'children':
					return storage.children(path);
				case 'list':
					return storage.list();
			}
		})();

		if ('value' in vector.expect) {
			expect(answer.error ?? null).toBeNull();
			expect(answer.data as unknown).toEqual(vector.expect.value);
		} else expect(answer.error).toMatchObject(vector.expect.error);
		for (const [path, text] of Object.entries(vector.after?.files ?? {}))
			expect(
				await readFile(join(root, path), 'utf8').catch(() => undefined),
			).toBe(text);
		for (const path of vector.after?.absent ?? [])
			expect(
				await lstat(join(root, path)).then(
					() => 'present',
					() => 'absent',
				),
			).toBe('absent');
		expect(
			await readdir(join(root, SCRATCH_DIRECTORY)).catch(() => []),
		).toEqual([]);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
