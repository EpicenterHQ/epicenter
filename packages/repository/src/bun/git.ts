/**
 * A `GitStore` over a local bare repository, through the `git` CLI's plumbing
 * commands. For tests and the CLI; the hosted store is a later slice.
 */
import { mkdir, stat } from 'node:fs/promises';
import type { GitStore, Tree, TreeEntry } from '../server/git-store.js';

const ZERO = '0'.repeat(40);
const decoder = new TextDecoder();

/** Open (creating if absent) a bare repository at `dir`. */
export async function openBunGitStore(dir: string): Promise<GitStore> {
	const exists = await stat(dir).then(
		() => true,
		() => false,
	);
	if (!exists) await mkdir(dir, { recursive: true });
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
	};

	async function git(args: string[], stdin?: Uint8Array) {
		const child = Bun.spawn(['git', '-C', dir, ...args], {
			stdin: stdin ?? 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).bytes(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	}

	async function must(args: string[], stdin?: Uint8Array) {
		const result = await git(args, stdin);
		if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
		return decoder.decode(result.stdout);
	}

	if (!exists || (await git(['rev-parse', '--git-dir'])).code !== 0)
		await must(['init', '--bare', '--initial-branch=main']);

	type Level = Map<string, TreeEntry | Level>;

	async function writeTreeLevel(entries: Level): Promise<string> {
		const lines: string[] = [];
		for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (entry instanceof Map) lines.push(`040000 tree ${await writeTreeLevel(entry)}\t${name}\0`);
			else
				lines.push(
					`${entry.mode} ${entry.mode === '160000' ? 'commit' : 'blob'} ${entry.oid}\t${name}\0`,
				);
		}
		return (await must(['mktree', '-z'], new TextEncoder().encode(lines.join('')))).trim();
	}

	return {
		async readRef(name) {
			const result = await git(['rev-parse', '--verify', '-q', `${name}^{commit}`]);
			return result.code === 0 ? decoder.decode(result.stdout).trim() : null;
		},
		async readCommit(oid) {
			const result = await git(['cat-file', 'commit', oid]);
			if (result.code !== 0) return null;
			const text = decoder.decode(result.stdout);
			const split = text.indexOf('\n\n');
			const header = text.slice(0, split < 0 ? text.length : split).split('\n');
			return {
				tree: header.find((line) => line.startsWith('tree '))?.slice(5) ?? '',
				parents: header.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
				message: split < 0 ? '' : text.slice(split + 2),
			};
		},
		async readTree(oid) {
			const out = await must(['ls-tree', '-r', '-z', '--full-tree', oid]);
			const tree: Tree = new Map();
			for (const record of out.split('\0')) {
				if (record === '') continue;
				const tab = record.indexOf('\t');
				const [mode = '', , entryOid = ''] = record.slice(0, tab).split(' ');
				tree.set(record.slice(tab + 1), { mode, oid: entryOid });
			}
			return tree;
		},
		async readBlob(oid) {
			if (!/^[0-9a-f]{40}$/.test(oid)) return null;
			const result = await git(['cat-file', 'blob', oid]);
			return result.code === 0 ? result.stdout : null;
		},
		async writeBlob(bytes) {
			return (await must(['hash-object', '-w', '--stdin'], bytes)).trim();
		},
		async writeTree(tree) {
			const root: Level = new Map();
			for (const [path, entry] of tree) {
				const parts = path.split('/');
				const name = parts.pop() ?? path;
				let level = root;
				for (const part of parts) {
					let next = level.get(part);
					if (!(next instanceof Map)) {
						next = new Map();
						level.set(part, next);
					}
					level = next;
				}
				level.set(name, entry);
			}
			return writeTreeLevel(root);
		},
		async writeCommit({ tree, parents, message, author, at }) {
			const date = `${Math.floor(at.getTime() / 1000)} +0000`;
			const child = Bun.spawn(
				['git', '-C', dir, 'commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'],
				{
					stdin: new TextEncoder().encode(message),
					stdout: 'pipe',
					stderr: 'pipe',
					env: {
						...env,
						GIT_AUTHOR_NAME: author.name,
						GIT_AUTHOR_EMAIL: author.email,
						GIT_AUTHOR_DATE: date,
						GIT_COMMITTER_NAME: author.name,
						GIT_COMMITTER_EMAIL: author.email,
						GIT_COMMITTER_DATE: date,
					},
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) throw new Error(`git commit-tree failed: ${stderr}`);
			return stdout.trim();
		},
		async updateRef(name, next, expected) {
			return (await git(['update-ref', name, next, expected ?? ZERO])).code === 0;
		},
		async mergeBase(a, b) {
			const result = await git(['merge-base', a, b]);
			return result.code === 0 ? decoder.decode(result.stdout).trim() : null;
		},
	};
}
