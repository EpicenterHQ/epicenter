#!/usr/bin/env bun
/** One-time offline history import. All Git operations use disposable filesystem copies. */
import { createHash } from 'node:crypto';
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
	basename,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
} from 'node:path';
import { parseArgs } from 'node:util';

type Entry = {
	path: string;
	type: 'directory' | 'file' | 'symlink' | 'special';
	mode: number;
	size?: number;
	sha256?: string;
	link?: string;
};
type Ref = {
	name: string;
	oid: string;
	type: string;
	peeled: string;
	peeledType: string;
	symref: string;
	originalAnchor: string;
	relocatedAnchor: string | null;
	relocated: string | null;
	reason?: string;
};
type Repo = {
	label: string;
	oldPath: string;
	prefix: string;
	kind: 'root' | 'code' | 'data';
	copy: string;
	head: string | null;
	symbolic: string | null;
	refs: Ref[];
	commits: string[];
	objects: Map<string, string>;
	commitMap: Record<string, string>;
	remotes: { key: string; url: string | null }[];
};
type TreeEntry = { mode: string; type: string; oid: string; path: string };
const gitEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
Object.assign(gitEnv, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_TERMINAL_PROMPT: '0',
	GIT_LFS_SKIP_SMUDGE: '1',
	GIT_AUTHOR_NAME: 'Epicenter migration',
	GIT_AUTHOR_EMAIL: 'migration@localhost',
	GIT_COMMITTER_NAME: 'Epicenter migration',
	GIT_COMMITTER_EMAIL: 'migration@localhost',
});
function command(args: string[], cwd?: string, input?: string | Buffer) {
	return Bun.spawnSync(args, {
		cwd,
		env: gitEnv,
		stdin: input === undefined ? 'ignore' : Buffer.from(input),
		stdout: 'pipe',
		stderr: 'pipe',
		maxBuffer: 256 * 1024 * 1024,
	});
}
function gitCommand(
	cwd: string,
	args: string[],
	input?: string | Buffer,
	hooks = true,
) {
	return command(
		[
			'git',
			...(hooks ? ['-c', 'core.hooksPath=/dev/null'] : []),
			'-c',
			'core.autocrlf=false',
			'-c',
			'core.fsmonitor=false',
			...args,
		],
		cwd,
		input,
	);
}
function git(cwd: string, ...args: string[]) {
	return gitInput(cwd, args).toString().trimEnd();
}
function gitInput(
	cwd: string,
	args: string[],
	input?: string | Buffer,
	hooks = true,
) {
	const r = gitCommand(cwd, args, input, hooks);
	if (r.exitCode !== 0)
		throw new Error(
			`Git ${args[0]} failed: ${r.stderr.toString().slice(0, 1800)}`,
		);
	return r.stdout;
}
function tryGit(cwd: string, ...args: string[]) {
	const r = gitCommand(cwd, args);
	return r.exitCode === 0 ? r.stdout.toString().trimEnd() : null;
}
function lines(s: string) {
	return s.split('\n').filter(Boolean);
}
function fail(message: string): never {
	throw new Error(message);
}
function hash(bytes: Uint8Array) {
	return createHash('sha256').update(bytes).digest('hex');
}
function stat(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
function canonical(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	if (parent === path) throw new Error(`Cannot resolve ${path}`);
	return join(canonical(parent), basename(path));
}
function inside(parent: string, child: string) {
	const rel = relative(parent, child);
	return (
		rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))
	);
}
function manifest(root: string, gitStorage = false) {
	const entries: Entry[] = [];
	const excluded: string[] = [];
	function walk(path: string) {
		const full = join(root, path);
		const info = lstatSync(full);
		const mode = info.mode & 0o7777;
		if (info.isSymbolicLink()) {
			const link = readlinkSync(full);
			entries.push({ path, type: 'symlink', mode, size: info.size, link });
		} else if (info.isDirectory()) {
			entries.push({ path, type: 'directory', mode, size: 0 });
			const inGit = gitStorage || path.split('/').includes('.git');
			if (
				!inGit &&
				(basename(path) === 'node_modules' ||
					/^apps\/[^/]+\/ui\/dist$/.test(path))
			) {
				excluded.push(path);
				return;
			}
			for (const name of readdirSync(full).sort()) walk(`${path}/${name}`);
		} else if (info.isFile()) {
			if (path === 'apps/.DS_Store') excluded.push(path);
			entries.push({
				path,
				type: 'file',
				mode,
				size: info.size,
				sha256: hash(readFileSync(full)),
			});
		} else {
			entries.push({ path, type: 'special', mode });
		}
	}
	for (const name of readdirSync(root).sort()) walk(name);
	return { entries, excluded };
}
function same(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}
function copyRepository(source: string, destination: string) {
	cpSync(source, destination, {
		recursive: true,
		verbatimSymlinks: true,
		filter: (path) => {
			const info = lstatSync(path);
			return info.isFile() || info.isDirectory() || info.isSymbolicLink();
		},
	});
	const entries = manifest(source, true).entries;
	for (const entry of entries.toReversed()) {
		if (entry.type !== 'symlink' && entry.type !== 'special')
			chmodSync(join(destination, entry.path), entry.mode);
	}
	chmodSync(destination, lstatSync(source).mode & 0o7777);
}
function stripCredentials(value: string) {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
	try {
		const url = new URL(value);
		if (url.protocol !== 'ssh:') url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return '<unparseable remote URL omitted>';
	}
}
function tree(repo: string, revision: string): TreeEntry[] {
	return gitInput(repo, ['ls-tree', '-rz', '--full-tree', revision])
		.toString()
		.split('\0')
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf('\t');
			const [mode = '', type = '', oid = ''] = line.slice(0, tab).split(' ');
			return { mode, type, oid, path: line.slice(tab + 1) };
		});
}
function objectTypes(repo: string, oids: string[]) {
	const result = new Map<string, string>();
	if (!oids.length) return result;
	for (const line of lines(
		gitInput(
			repo,
			['cat-file', '--batch-check=%(objectname) %(objecttype)'],
			`${oids.join('\n')}\n`,
		).toString(),
	)) {
		const [oid = '', type = ''] = line.split(' ');
		result.set(oid, type);
	}
	return result;
}
// cat-file frames binary blobs by byte length, so embedded newlines and NULs
// cannot be interpreted as headers or separators.
function smallBlobs(repo: string, sizes: string[]) {
	const oids = sizes.flatMap((line) => {
		const [oid = '', type = '', size = ''] = line.split(' ');
		return type === 'blob' && Number(size) <= 1024 ? [oid] : [];
	});
	const blobs = new Map<string, Buffer>();
	if (!oids.length) return blobs;
	const stream = gitInput(
		repo,
		['cat-file', '--batch'],
		`${oids.join('\n')}\n`,
	);
	let offset = 0;
	for (const expectedOid of oids) {
		const headerEnd = stream.indexOf(0x0a, offset);
		if (headerEnd === -1) fail('Truncated cat-file batch header');
		const [oid = '', type = '', sizeText = ''] = stream
			.subarray(offset, headerEnd)
			.toString('ascii')
			.split(' ');
		const size = Number(sizeText);
		if (
			oid !== expectedOid ||
			type !== 'blob' ||
			!/^\d+$/.test(sizeText) ||
			!Number.isSafeInteger(size) ||
			size > 1024
		)
			fail(`Unexpected cat-file batch header: ${expectedOid}`);
		const start = headerEnd + 1;
		const end = start + size;
		if (end >= stream.length || stream[end] !== 0x0a)
			fail(`Truncated cat-file batch blob: ${oid}`);
		blobs.set(oid, stream.subarray(start, end));
		offset = end + 1;
	}
	if (offset !== stream.length)
		fail('Unexpected trailing cat-file batch bytes');
	return blobs;
}
function reachable(repo: string, head: string | null) {
	const output = git(
		repo,
		'rev-list',
		'--objects',
		'--all',
		...(head ? [head] : []),
	);
	return [
		...new Map(
			lines(output).map((line) => {
				const at = line.indexOf(' ');
				return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
			}),
		).entries(),
	];
}
function pointer(bytes: Buffer, context = 'LFS blob') {
	const match =
		/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (0|[1-9][0-9]*)\n?$/.exec(
			bytes.toString(),
		);
	if (!match) {
		if (
			bytes
				.subarray(0, 'version https://git-lfs.github.com/spec/v1'.length)
				.toString() === 'version https://git-lfs.github.com/spec/v1'
		)
			fail(`${context}: pointer form is unsupported`);
		return null;
	}
	const size = Number(match[2]);
	if (!Number.isSafeInteger(size))
		fail(
			`${context}: pointer form is unsupported (size exceeds safe integer range)`,
		);
	return { oid: match[1] ?? fail('LFS pointer oid missing'), size };
}
function localPath(path: string) {
	return path.split('/').some((part) => /\.local(\.|$)/i.test(part));
}
function transformIgnore(bytes: Buffer) {
	let text = bytes
		.toString('latin1')
		.replace(/^(?:apps\/?|\/apps\/?)\r?$(?:\n|$)/gm, '');
	for (const rule of ['*.local', '*.local.*', 'node_modules/'])
		if (!text.split(/\r?\n/).includes(rule))
			text += `${text && !text.endsWith('\n') ? '\n' : ''}${rule}\n`;
	return Buffer.from(text, 'latin1');
}
function safeMetadata(bytes: Buffer) {
	const text = bytes.toString('latin1');
	const split = text.indexOf('\n\n');
	const headers = text.slice(0, split).split('\n');
	const kept: string[] = [];
	let drop = false;
	for (const line of headers) {
		if (!line.startsWith(' '))
			drop = /^(tree|parent|gpgsig|gpgsig-sha256|mergetag) /.test(line);
		if (!drop) kept.push(line);
	}
	return `${kept.join('\n')}\n\n${text.slice(split + 2)}`;
}
export function migrate({
	source: sourceArg,
	out: outArg,
	filterRepo,
}: {
	source: string;
	out: string;
	filterRepo?: string;
}) {
	const scratch = mkdtempSync(join(tmpdir(), 'epicenter-migrate-preflight-'));
	let building = false;
	const verification: { check: string; passed: boolean; paths?: string[] }[] =
		[];
	const check = (name: string, passed: boolean, paths?: string[]) =>
		verification.push({
			check: name,
			passed,
			...(paths?.length ? { paths } : {}),
		});
	let source = '',
		out = '';
	let report: Record<string, unknown> = {};
	try {
		source = canonical(resolve(sourceArg));
		out = canonical(resolve(outArg));
		if (inside(source, out) || inside(out, source))
			fail('source and out must be separate, non-nested directories');
		for (const live of [
			join(process.env.HOME ?? '', 'Epicenter'),
			process.env.EPICENTER_ROOT,
		])
			if (live) {
				const path = canonical(resolve(live));
				if (inside(source, path) || inside(path, source))
					fail('migrate a stopped copy: source overlaps a live Epicenter path');
			}
		if (
			!stat(source)?.isDirectory() ||
			!stat(join(source, 'EPICENTER.md'))?.isFile()
		)
			fail('Source requires EPICENTER.md');
		if (stat(out) && (!stat(out)?.isDirectory() || readdirSync(out).length))
			fail(`out must be empty: ${out}`);
		if (!stat(join(source, '.git'))?.isDirectory())
			fail('Source .git must be a directory, not a gitdir pointer');
		if (!stat(join(source, 'apps'))?.isDirectory())
			fail('Source apps/ must be a real directory');
		const apps = readdirSync(join(source, 'apps'))
			.sort()
			.filter((name) => name !== '.DS_Store');
		for (const app of apps) {
			if (
				!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(app) ||
				gitCommand(scratch, ['check-ref-format', `refs/heads/${app}`])
					.exitCode !== 0
			)
				fail(`Invalid app name: ${app}`);
			for (const path of [
				`apps/${app}`,
				`apps/${app}/.git`,
				`apps/${app}/data`,
				`apps/${app}/data/.git`,
			])
				if (!stat(join(source, path))?.isDirectory())
					fail(`Expected real directory: ${path}`);
		}
		const positions = new Set([
			'.git',
			...apps.flatMap((app) => [`apps/${app}/.git`, `apps/${app}/data/.git`]),
		]);
		function inspect(path: string) {
			for (const name of readdirSync(join(source, path))) {
				const child = posix.join(path, name);
				const info = lstatSync(join(source, child));
				if (name === '.git') {
					if (!positions.has(child)) fail(`embedded repository: ${child}`);
					if (!info.isDirectory())
						fail(`.git file or symlink refused: ${child}`);
				} else if (info.isDirectory() && name !== 'node_modules')
					inspect(child);
			}
		}
		inspect('');
		const before = manifest(source);
		const mapPath = (path: string) => {
			const parts = path.split('/');
			if (
				parts[0] === 'apps' &&
				apps.includes(parts[1] ?? '') &&
				parts.length > 2 &&
				parts[2] !== 'data'
			)
				parts.splice(2, 0, 'code');
			return parts.join('/');
		};
		const repos: Repo[] = [
			{ label: 'root', oldPath: '', prefix: '', kind: 'root' },
			...apps.flatMap((app) => [
				{
					label: `${app}.code`,
					oldPath: `apps/${app}`,
					prefix: `apps/${app}/code`,
					kind: 'code' as const,
				},
				{
					label: `${app}.data`,
					oldPath: `apps/${app}/data`,
					prefix: `apps/${app}/data`,
					kind: 'data' as const,
				},
			]),
		].map((repo) => ({
			...repo,
			kind: repo.kind as Repo['kind'],
			copy: '',
			head: null,
			symbolic: null,
			refs: [],
			commits: [],
			objects: new Map(),
			commitMap: {},
			remotes: [],
		}));
		const repoFor = (path: string) =>
			repos
				.toReversed()
				.find((repo) => repo.oldPath && inside(repo.oldPath, path)) ??
			repos[0] ??
			fail('Root repository missing');
		function linkText(repo: Repo, path: string, text: string, where: string) {
			const location = posix.join(repo.oldPath, path);
			if (isAbsolute(text)) {
				if (
					inside(source, resolve(text)) ||
					inside(resolve(sourceArg), resolve(text))
				)
					fail(
						`${repo.label} ${where} ${path}: absolute link points into source copy`,
					);
				return text;
			}
			const target = posix.normalize(posix.join(posix.dirname(location), text));
			if (target.split('/').includes('.git') || target === 'repositories.json')
				fail(
					`${repo.label} ${where} ${path}: link targets removed metadata (${JSON.stringify(text)})`,
				);
			const needed = posix.normalize(
				posix.join(posix.dirname(mapPath(location)), text),
			);
			if (needed === mapPath(target)) return text;
			if (
				repo.kind === 'code' &&
				path === 'ui/src/theme.css' &&
				text === '../../../../theme.css'
			)
				return '../../../../../theme.css';
			fail(
				`${repo.label} ${where} ${path}: meaning-changing symlink ${JSON.stringify(text)}`,
			);
		}
		const payloads = new Map<string, { path: string; size: number }>();
		const pointers: {
			repo: string;
			blob: string;
			oid: string;
			size: number;
			path: string;
		}[] = [];
		const historicalGitlinks: {
			repo: string;
			commit: string;
			path: string;
			oid: string;
		}[] = [];
		const localSecretOccurrences: {
			repo: string;
			ref?: string;
			commit: string;
			path: string;
			blob: string;
		}[] = [];
		const themes = new Map<
			string,
			{
				repo: string;
				path: string;
				oldBlob: string;
				oldText: string;
				oldMode: string;
				newBlob: string;
				newText: string;
				newMode: string;
				commits: number;
			}
		>();
		let hasAttributes = false;
		for (const repo of repos) {
			const original = join(source, repo.oldPath, '.git');
			const entries = manifest(original, true).entries;
			for (const e of entries) {
				if (
					e.type === 'symlink' ||
					e.type === 'special' ||
					e.path.endsWith('.lock')
				)
					fail(`${repo.label}: unsupported Git storage: ${e.path}`);
			}
			for (const p of [
				'objects/info/alternates',
				'objects/info/grafts',
				'commondir',
				'shallow',
				'modules',
			])
				if (stat(join(original, p)))
					fail(`${repo.label}: unsupported Git storage: ${p}`);
			for (const p of ['refs/replace', 'worktrees'])
				if (stat(join(original, p)) && readdirSync(join(original, p)).length)
					fail(`${repo.label}: unsupported non-empty ${p}`);
			repo.copy = join(scratch, `${repo.label}.git`);
			copyRepository(original, repo.copy);
			const config = git(
				repo.copy,
				'config',
				'--file',
				join(repo.copy, 'config'),
				'--no-includes',
				'--list',
			);
			for (const line of lines(config))
				if (
					/^(extensions\.(refstorage|partialclone)|remote\..*\.promisor|core\.worktree)=/i.test(
						line,
					) ||
					/^core\.bare=true$/i.test(line)
				)
					fail(`${repo.label}: unsupported Git config ${line.split('=')[0]}`);
			for (const item of (
				tryGit(
					repo.copy,
					'config',
					'--file',
					join(repo.copy, 'config'),
					'--no-includes',
					'--null',
					'--get-regexp',
					'^remote\\..*\\.(url|pushurl)$',
				) ?? ''
			)
				.split('\0')
				.filter(Boolean)) {
				const at = item.indexOf('\n');
				repo.remotes.push({
					key: item.slice(0, at),
					url: stripCredentials(item.slice(at + 1)),
				});
			}
			// Disable include files and source-local execution in disposable copies only.
			writeFileSync(
				join(repo.copy, 'config'),
				'[core]\nrepositoryformatversion = 0\nbare = true\n',
			);
			git(repo.copy, 'fsck', '--no-dangling');
			repo.head = tryGit(repo.copy, 'rev-parse', '--verify', 'HEAD');
			repo.symbolic = tryGit(repo.copy, 'symbolic-ref', '-q', 'HEAD');
			if (repo.head) {
				const staged = git(
					repo.copy,
					'diff-index',
					'--cached',
					'--name-only',
					'HEAD',
				);
				if (staged)
					fail(
						`${repo.label}: commit or unstage in the stopped copy first: ${staged}`,
					);
			}
			const index = git(repo.copy, 'ls-files', '--stage');
			if (lines(index).some((line) => line.startsWith('160000 ')))
				fail(`${repo.label}: current gitlink in index`);
			repo.refs = lines(
				git(
					repo.copy,
					'for-each-ref',
					'--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)',
				),
			).map((line) => {
				const [name = '', oid = '', type = '', symref = ''] = line.split('\0');
				const peeled = git(repo.copy, 'rev-parse', `${oid}^{}`);
				return {
					name,
					oid,
					type,
					symref,
					peeled,
					peeledType: git(repo.copy, 'cat-file', '-t', peeled),
					originalAnchor: '',
					relocatedAnchor: null,
					relocated: null,
				};
			});
			if (
				repo.label === 'root' &&
				repo.refs.some((ref) =>
					ref.name.startsWith('refs/tags/epicenter-migration/'),
				)
			)
				fail('Root already contains refs/tags/epicenter-migration/');
			const starts = [
				...repo.refs
					.filter((ref) => ref.peeledType === 'commit')
					.map((ref) => ref.peeled),
				...(repo.head ? [repo.head] : []),
			];
			repo.commits = starts.length
				? lines(
						gitInput(
							repo.copy,
							['rev-list', '--stdin'],
							`${starts.join('\n')}\n`,
						).toString(),
					)
				: [];
			const objects = reachable(repo.copy, repo.head);
			repo.objects = objectTypes(
				repo.copy,
				objects.map(([oid]) => oid),
			);
			for (const e of entries.filter(
				(e) => e.type === 'file' && e.path.startsWith('lfs/objects/'),
			)) {
				const oid = basename(e.path);
				if (
					!/^[a-f0-9]{64}$/.test(oid) ||
					e.sha256 !== oid ||
					e.path !== `lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
				)
					fail(`${repo.label}: invalid LFS payload ${e.path}`);
				payloads.set(oid, {
					path: join(original, e.path),
					size: e.size ?? fail(`Missing size: ${e.path}`),
				});
			}
			const sizes = objects.length
				? lines(
						gitInput(
							repo.copy,
							[
								'cat-file',
								'--batch-check=%(objectname) %(objecttype) %(objectsize)',
							],
							`${objects.map(([oid]) => oid).join('\n')}\n`,
						).toString(),
					)
				: [];
			const names = new Map(objects);
			const blobs = smallBlobs(repo.copy, sizes);
			function readBlob(oid: string) {
				const cached = blobs.get(oid);
				if (cached) return cached;
				const bytes = gitInput(repo.copy, ['cat-file', 'blob', oid]);
				blobs.set(oid, bytes);
				return bytes;
			}
			for (const [oid, bytes] of blobs) {
				const path = names.get(oid) || '<direct ref>';
				const p = pointer(bytes, `${repo.label}: blob ${oid}, path ${path}`);
				if (p) pointers.push({ repo: repo.label, blob: oid, ...p, path });
			}
			for (const commit of repo.commits) {
				for (const entry of tree(repo.copy, commit)) {
					if (entry.mode === '160000') {
						if (commit === repo.head)
							fail(`${repo.label}: current gitlink ${entry.path}`);
						historicalGitlinks.push({
							repo: repo.label,
							commit,
							path: entry.path,
							oid: entry.oid,
						});
					}
					if (
						basename(entry.path) === '.gitattributes' &&
						/(?:^|\s)filter=lfs(?:\s|$)/m.test(readBlob(entry.oid).toString())
					)
						hasAttributes = true;
					if (localPath(entry.path))
						localSecretOccurrences.push({
							repo: repo.label,
							commit,
							path: entry.path,
							blob: entry.oid,
						});
					if (entry.mode === '120000') {
						const text = readBlob(entry.oid).toString();
						const rewritten = linkText(repo, entry.path, text, commit);
						if (rewritten !== text) {
							const key = `${repo.label}:${entry.oid}`;
							const existing = themes.get(key);
							if (existing) existing.commits++;
							else
								themes.set(key, {
									repo: repo.label,
									path: entry.path,
									oldBlob: entry.oid,
									oldText: text,
									oldMode: entry.mode,
									newBlob: gitInput(
										repo.copy,
										['hash-object', '--stdin'],
										rewritten,
									)
										.toString()
										.trim(),
									newText: rewritten,
									newMode: '120000',
									commits: 1,
								});
						}
					}
				}
			}
			// Tree refs also have paths, even though they cannot be relocated as histories.
			for (const ref of repo.refs.filter((ref) => ref.peeledType === 'tree'))
				for (const entry of tree(repo.copy, ref.peeled)) {
					if (localPath(entry.path))
						localSecretOccurrences.push({
							repo: repo.label,
							ref: ref.name,
							commit: ref.peeled,
							path: entry.path,
							blob: entry.oid,
						});
					if (entry.mode === '120000')
						linkText(
							repo,
							entry.path,
							readBlob(entry.oid).toString(),
							ref.name,
						);
				}
		}
		for (const e of before.entries) {
			if (e.path.split('/').includes('.git')) continue;
			if (e.type === 'symlink') {
				const repo = repoFor(e.path);
				linkText(
					repo,
					posix.relative(repo.oldPath || '.', e.path),
					e.link ?? fail(`Missing symlink text: ${e.path}`),
					'working tree',
				);
			}
			if (
				e.type === 'file' &&
				basename(e.path) === '.gitattributes' &&
				/(?:^|\s)filter=lfs(?:\s|$)/m.test(
					readFileSync(join(source, e.path), 'utf8'),
				)
			)
				hasAttributes = true;
		}
		for (const p of pointers) {
			const payload = payloads.get(p.oid);
			if (!payload || payload.size !== p.size)
				fail(
					`${p.repo}: missing or mismatched LFS payload, pointer ${p.blob}, oid ${p.oid}, path ${p.path}`,
				);
		}
		const filterCommand = filterRepo
			? [resolve(filterRepo)]
			: [
					'git',
					'-c',
					'core.hooksPath=/dev/null',
					'-c',
					'core.autocrlf=false',
					'-c',
					'core.fsmonitor=false',
					'filter-repo',
				];
		const missingFilter =
			'git-filter-repo is required; install it (for example: brew install git-filter-repo) or pass --filter-repo <path>';
		const version = (() => {
			try {
				return command([...filterCommand, '--version'], scratch);
			} catch {
				return fail(missingFilter);
			}
		})();
		if (version.exitCode !== 0) fail(missingFilter);
		const lfs = gitCommand(scratch, ['lfs', 'version']);
		if ((pointers.length || hasAttributes) && lfs.exitCode !== 0)
			fail('git-lfs is required for LFS pointers or attributes');
		const root = repos[0] ?? fail('Root repository missing');
		if (!root.head || !root.symbolic?.startsWith('refs/heads/'))
			fail('Root HEAD must be on a branch with a commit');
		const rootBranch = root.symbolic.slice('refs/heads/'.length);
		const capture = `c${hash(Buffer.from(JSON.stringify(repos.map((repo) => [repo.label, { oid: repo.head, symbolic: repo.symbolic }, repo.refs.map((ref) => ({ name: ref.name, oid: ref.oid, symref: ref.symref })).sort((a, b) => a.name.localeCompare(b.name))])))).slice(0, 12)}`;
		const namespace = `refs/tags/epicenter-migration/${capture}`;
		const anchor = (repo: Repo, kind: string, name: string) =>
			`${namespace}/${kind}/${repo.label}/${name}`;
		for (const repo of repos) {
			for (const ref of repo.refs) {
				ref.originalAnchor = anchor(repo, 'original', ref.name);
				if (repo.kind !== 'root' && ref.peeledType === 'commit')
					ref.relocatedAnchor = anchor(repo, 'relocated', ref.name);
				else if (repo.kind !== 'root')
					ref.reason =
						'non-commit object has no path; original anchor preserves it';
				for (const name of [ref.originalAnchor, ref.relocatedAnchor].filter(
					(v): v is string => !!v,
				))
					git(scratch, 'check-ref-format', name);
			}
			git(scratch, 'check-ref-format', anchor(repo, 'original', 'HEAD'));
		}
		const versions = {
			git: git(scratch, '--version'),
			filterRepo: version.stdout.toString().trim(),
			lfs: lfs.exitCode === 0 ? lfs.stdout.toString().trim() : null,
		};
		// Only now may the output be created.
		building = true;
		mkdirSync(out, { recursive: true });
		for (const dir of [
			'originals',
			'bundles',
			'maps',
			'work',
			'removed-working-files',
		])
			mkdirSync(join(out, dir));
		const candidate = join(out, 'Epicenter');
		mkdirSync(candidate);
		git(candidate, 'init', `--initial-branch=${rootBranch}`);
		const bundleReports: {
			repo: string;
			excluded: string[];
			verified: boolean;
			reason?: string;
		}[] = [];
		function fetch(from: string, to: string, oid: string, destination: string) {
			git(
				to,
				'fetch',
				'--no-tags',
				'--no-write-fetch-head',
				from,
				`${oid}:${destination}`,
			);
		}
		for (const repo of repos) {
			const original = join(source, repo.oldPath, '.git');
			const archive = join(out, 'originals', `${repo.label}.git`);
			copyRepository(original, archive);
			check(
				`archive ${repo.label} byte-exact`,
				same(manifest(original, true), manifest(archive, true)) &&
					(lstatSync(original).mode & 0o7777) ===
						(lstatSync(archive).mode & 0o7777),
			);
			const bundle = join(out, 'bundles', `${repo.label}.bundle`);
			const commitRefs = repo.refs.filter((ref) => ref.peeledType === 'commit');
			if (repo.refs.length || repo.head) {
				const bundled = gitCommand(repo.copy, [
					'bundle',
					'create',
					bundle,
					'--all',
					...(repo.head ? ['HEAD'] : []),
				]);
				let excluded: string[] = [];
				if (bundled.exitCode !== 0) {
					excluded = repo.refs
						.filter((ref) => ref.peeledType !== 'commit')
						.map((ref) => ref.name);
					if (!excluded.length)
						fail(
							`bundle ${repo.label} failed: ${bundled.stderr.toString().slice(0, 1200)}`,
						);
					rmSync(bundle, { force: true });
					git(
						repo.copy,
						'bundle',
						'create',
						bundle,
						...commitRefs.map((ref) => ref.name),
						...(repo.head ? ['HEAD'] : []),
					);
				}
				git(repo.copy, 'bundle', 'verify', bundle);
				const heads = new Set(
					lines(git(repo.copy, 'bundle', 'list-heads', bundle)),
				);
				check(
					`bundle ${repo.label} refs`,
					repo.refs
						.filter((ref) => !excluded.includes(ref.name))
						.every((ref) => heads.has(`${ref.oid} ${ref.name}`)) &&
						(!repo.head || heads.has(`${repo.head} HEAD`)),
				);
				bundleReports.push({
					repo: repo.label,
					excluded,
					verified: true,
					...(excluded.length
						? {
								reason:
									'Git refused non-commit refs; original anchors and archives preserve them',
							}
						: {}),
				});
			} else
				bundleReports.push({
					repo: repo.label,
					excluded: [],
					verified: false,
					reason:
						'Unborn repository has no objects or refs to bundle; exact .git archive preserves it',
				});
			for (const ref of repo.refs)
				fetch(repo.copy, candidate, ref.oid, ref.originalAnchor);
			if (repo.head)
				fetch(
					repo.copy,
					candidate,
					repo.head,
					anchor(repo, 'original', 'HEAD'),
				);
			if (repo.kind === 'root') {
				for (const ref of repo.refs.filter(
					(ref) =>
						ref.name.startsWith('refs/tags/') ||
						(ref.name.startsWith('refs/heads/') && ref.name !== root.symbolic),
				))
					fetch(repo.copy, candidate, ref.oid, ref.name);
				continue;
			}
			const relocated = join(out, 'work', `${repo.label}.git`);
			git(join(out, 'work'), 'init', '--bare', relocated);
			for (const ref of commitRefs)
				fetch(repo.copy, relocated, ref.oid, ref.name);
			if (repo.head)
				fetch(repo.copy, relocated, repo.head, 'refs/epicenter-import/HEAD');
			if (commitRefs.length || repo.head) {
				const callback = `if filename == ${JSON.stringify(`${repo.prefix}/ui/src/theme.css`).replace(/^"/, 'b"')} and mode == b'120000' and value.get_contents_by_identifier(blob_id) == b'../../../../theme.css':\n  blob_id = value.insert_file_with_contents(b'../../../../../theme.css')\nreturn (filename, mode, blob_id)`;
				const args = [
					'--force',
					'--partial',
					'--preserve-commit-hashes',
					'--preserve-commit-encoding',
					'--prune-empty',
					'never',
					'--prune-degenerate',
					'never',
					'--to-subdirectory-filter',
					repo.prefix,
					...(repo.kind === 'code' ? ['--file-info-callback', callback] : []),
				];
				const filtered = command([...filterCommand, ...args], relocated);
				if (filtered.exitCode !== 0)
					fail(
						`filter-repo ${repo.label}: ${filtered.stderr.toString().slice(0, 1600)}`,
					);
				mkdirSync(join(out, 'maps', repo.label));
				for (const name of ['commit-map', 'ref-map'])
					cpSync(
						join(relocated, 'filter-repo', name),
						join(out, 'maps', repo.label, name),
					);
				for (const line of lines(
					readFileSync(join(relocated, 'filter-repo/commit-map'), 'utf8'),
				).slice(1)) {
					const [old = '', next = ''] = line.split(/\s+/);
					repo.commitMap[old] = next;
				}
				for (const ref of commitRefs) {
					ref.relocated = git(relocated, 'rev-parse', ref.name);
					fetch(
						relocated,
						candidate,
						ref.relocated,
						ref.relocatedAnchor ??
							fail(`Missing relocated anchor: ${ref.name}`),
					);
				}
				if (repo.head)
					fetch(
						relocated,
						candidate,
						git(relocated, 'rev-parse', 'refs/epicenter-import/HEAD'),
						anchor(repo, 'relocated', 'HEAD'),
					);
			}
		}
		for (const [oid, payload] of payloads) {
			const path = join(
				candidate,
				'.git/lfs/objects',
				oid.slice(0, 2),
				oid.slice(2, 4),
				oid,
			);
			mkdirSync(dirname(path), { recursive: true });
			cpSync(payload.path, path);
		}
		if (lfs.exitCode === 0) {
			gitInput(candidate, ['lfs', 'install', '--local'], undefined, false);
			for (const name of [
				'pre-push',
				'post-checkout',
				'post-commit',
				'post-merge',
			]) {
				const path = join(candidate, '.git/hooks', name);
				check(
					`LFS hook ${name}`,
					!!stat(path)?.isFile() &&
						!!(lstatSync(path).mode & 0o111) &&
						/git lfs/.test(readFileSync(path, 'utf8')),
				);
			}
			for (const name of ['clean', 'smudge', 'process', 'required'])
				check(
					`LFS filter ${name}`,
					!!tryGit(candidate, 'config', '--local', `filter.lfs.${name}`),
				);
		}
		const globalConfigPaths = [
			process.env.GIT_CONFIG_GLOBAL ??
				join(process.env.HOME ?? '', '.gitconfig'),
			join(
				process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
				'git/config',
			),
		];
		const globalHooksPathConfigured = globalConfigPaths.some(
			(path) =>
				stat(path)?.isFile() &&
				tryGit(
					scratch,
					'config',
					'--file',
					path,
					'--includes',
					'--get',
					'core.hooksPath',
				) !== null,
		);
		const expectedWorking: Entry[] = [];
		for (const entry of before.entries) {
			if (
				entry.path.split('/').includes('.git') ||
				before.excluded.some((path) => inside(path, entry.path)) ||
				entry.type === 'special' ||
				entry.path === 'apps/.DS_Store'
			)
				continue;
			if (entry.path === 'repositories.json') {
				cpSync(
					join(source, entry.path),
					join(out, 'removed-working-files/repositories.json'),
				);
				continue;
			}
			const mapped = mapPath(entry.path);
			const destination = join(candidate, mapped);
			mkdirSync(dirname(destination), { recursive: true });
			if (entry.type === 'directory') {
				mkdirSync(destination, { recursive: true });
			} else if (entry.type === 'symlink') {
				const repo = repoFor(entry.path);
				symlinkSync(
					linkText(
						repo,
						posix.relative(repo.oldPath || '.', entry.path),
						entry.link ?? fail(`Missing symlink text: ${entry.path}`),
						'working tree',
					),
					destination,
				);
			} else {
				const bytes = readFileSync(join(source, entry.path));
				writeFileSync(
					destination,
					entry.path === '.gitignore' ? transformIgnore(bytes) : bytes,
				);
				chmodSync(destination, entry.mode);
			}
			expectedWorking.push({
				...entry,
				path: mapped,
				...(entry.type === 'symlink'
					? { link: readlinkSync(destination) }
					: {}),
				...(entry.type === 'file'
					? {
							sha256: hash(readFileSync(destination)),
							size: lstatSync(destination).size,
						}
					: {}),
			});
		}
		for (const entry of expectedWorking
			.toReversed()
			.filter((e) => e.type === 'directory'))
			chmodSync(join(candidate, entry.path), entry.mode);
		const parents = [
			root.head,
			...repos
				.filter((repo) => repo.kind === 'code')
				.flatMap((repo) =>
					repo.head
						? [
								repo.commitMap[repo.head] ??
									fail(`Missing HEAD mapping: ${repo.label}`),
							]
						: [],
				),
			...repos
				.filter((repo) => repo.kind === 'data')
				.flatMap((repo) =>
					repo.head
						? [
								repo.commitMap[repo.head] ??
									fail(`Missing HEAD mapping: ${repo.label}`),
							]
						: [],
				),
		];
		const transformations = [
			'apps/<name>/<code path> -> apps/<name>/code/<code path>',
			'apps/<name>/data paths unchanged',
			'remove working repositories.json (bytes saved outside candidate)',
			'root .gitignore: remove exact apps exclusions; ensure local and node_modules exclusions',
			'theme symlink: ../../../../theme.css -> ../../../../../theme.css only for mode 120000 at code ui/src/theme.css',
			'root commits and signatures unchanged; relocated commit and annotated tag signatures stripped',
		];
		const recovery = [
			'git restore --source=<relocated-code-commit> -- apps/<name>/code/',
			'git restore --source=<relocated-data-commit> -- apps/<name>/data/',
			'Restoring whole apps/<name>/ from a pre-combine commit removes its sibling code or data.',
		];
		const limits = [
			'Combine commit is unsigned. Relocated commits and annotated tags are unsigned; original signatures remain under original anchors.',
			'Older stash reflog entries, all other reflogs, index, config, hooks and unreachable objects are archive-only.',
			'AGENTS.md and EPICENTER.md are stale guidance requiring coordinator rewrite before live use.',
			'Do not publish the namespace until publication blockers have been reviewed. Deleting a file later does not remove it from history.',
		];
		const manifestData = {
			capture,
			tool: 'migrate-to-one-repository',
			versions,
			rootBranch,
			repositories: repos.map((repo) => ({
				label: repo.label,
				oldPath: repo.oldPath,
				newPrefix: repo.prefix,
				HEAD: { oid: repo.head, symbolic: repo.symbolic },
				headAnchors: {
					original: repo.head ? anchor(repo, 'original', 'HEAD') : null,
					relocated:
						repo.head && repo.kind !== 'root'
							? anchor(repo, 'relocated', 'HEAD')
							: null,
				},
				refs: repo.refs,
				commitMap: repo.commitMap,
				remotes: repo.remotes,
				relocation:
					repo.kind === 'root'
						? 'unchanged: original root objects'
						: repo.prefix,
			})),
			themeTransformations: [...themes.values()],
			lfsPointers: pointers,
			historicalGitlinks,
			combineParents: parents,
			transformations,
			recovery,
			limits,
		};
		const manifestPath = `.epicenter-migration/${capture}.json`;
		mkdirSync(join(candidate, '.epicenter-migration'), { recursive: true });
		writeFileSync(
			join(candidate, manifestPath),
			`${JSON.stringify(manifestData, null, 2)}\n`,
		);
		git(candidate, 'add', '-A');
		const combinedTree = git(candidate, 'write-tree');
		const combinedEntries = tree(candidate, combinedTree);
		if (combinedEntries.some((e) => e.mode === '160000' || localPath(e.path)))
			fail('Candidate index contains gitlinks or local-secret paths');
		const message = `Combine stopped Epicenter repositories\n\n${repos.map((repo) => `${repo.label}: ${repo.head ?? 'unborn'} -> ${repo.kind === 'root' ? repo.head : repo.head ? repo.commitMap[repo.head] : 'no parent'}`).join('\n')}\n`;
		const combineCommit = gitInput(
			candidate,
			[
				'-c',
				'commit.gpgsign=false',
				'commit-tree',
				combinedTree,
				...parents.flatMap((parent) => ['-p', parent]),
			],
			message,
		)
			.toString()
			.trim();
		git(candidate, 'update-ref', root.symbolic, combineCommit);
		git(candidate, 'symbolic-ref', 'HEAD', root.symbolic);
		git(candidate, 'reset', '-q');
		check(
			'clean candidate status',
			git(candidate, 'status', '--porcelain', '--untracked-files=all') === '',
		);
		check('source unchanged', same(before, manifest(source)));
		for (const theme of themes.values()) {
			const repo =
				repos.find((repo) => repo.label === theme.repo) ??
				fail(`Theme repository missing: ${theme.repo}`);
			const oldLocation = posix.join(repo.oldPath, theme.path);
			const newLocation = mapPath(oldLocation);
			const oldTarget = posix.normalize(
				posix.join(posix.dirname(oldLocation), theme.oldText),
			);
			const newTarget = posix.normalize(
				posix.join(posix.dirname(newLocation), theme.newText),
			);
			check(
				`theme link target ${theme.repo} ${theme.path}`,
				newTarget === mapPath(oldTarget),
				[newLocation, mapPath(oldTarget)],
			);
		}

		for (const repo of repos) {
			check(
				`archive ${repo.label} unchanged`,
				same(
					manifest(join(source, repo.oldPath, '.git'), true),
					manifest(join(out, 'originals', `${repo.label}.git`), true),
				),
			);
			for (const ref of repo.refs) {
				check(
					`original anchor ${repo.label} ${ref.name}`,
					git(candidate, 'rev-parse', ref.originalAnchor) === ref.oid &&
						git(candidate, 'cat-file', '-t', ref.originalAnchor) === ref.type,
				);
				if (ref.relocatedAnchor) {
					const peeled = git(
						candidate,
						'rev-parse',
						`${ref.relocatedAnchor}^{}`,
					);
					check(
						`relocated anchor ${repo.label} ${ref.name}`,
						peeled === repo.commitMap[ref.peeled],
					);
				}
			}
			if (repo.head)
				check(
					`HEAD anchor ${repo.label}`,
					git(candidate, 'rev-parse', anchor(repo, 'original', 'HEAD')) ===
						repo.head,
				);
			if (repo.head && repo.kind !== 'root')
				check(
					`relocated HEAD ${repo.label}`,
					git(candidate, 'rev-parse', anchor(repo, 'relocated', 'HEAD')) ===
						repo.commitMap[repo.head],
				);
			const actual = objectTypes(candidate, [...repo.objects.keys()]);
			check(
				`all original objects ${repo.label}`,
				[...repo.objects].every(([oid, type]) => actual.get(oid) === type),
			);
			if (repo.kind !== 'root')
				for (const old of repo.commits) {
					const next = repo.commitMap[old];
					if (!next || /^0+$/.test(next)) {
						check(`commit map ${repo.label} ${old}`, false);
						continue;
					}
					const oldRaw = gitInput(repo.copy, ['cat-file', 'commit', old]);
					const newRaw = gitInput(candidate, ['cat-file', 'commit', next]);
					const oldParents = lines(
						git(repo.copy, 'show', '-s', '--format=%P', old),
					).flatMap((line) => line.split(' '));
					const newParents = git(candidate, 'show', '-s', '--format=%P', next)
						.split(' ')
						.filter(Boolean);
					const expected = tree(repo.copy, old)
						.map((e) => {
							const theme = themes.get(`${repo.label}:${e.oid}`);
							return {
								...e,
								path: `${repo.prefix}/${e.path}`,
								oid:
									e.mode === '120000' && e.path === 'ui/src/theme.css' && theme
										? theme.newBlob
										: e.oid,
							};
						})
						.sort((a, b) => a.path.localeCompare(b.path));
					const actualTree = tree(candidate, next).sort((a, b) =>
						a.path.localeCompare(b.path),
					);
					check(
						`relocated commit ${repo.label} ${old}`,
						same(
							oldParents.map((parent) => repo.commitMap[parent]),
							newParents,
						) &&
							safeMetadata(oldRaw) === safeMetadata(newRaw) &&
							same(expected, actualTree),
					);
				}
		}
		check(
			'original root HEAD ancestor',
			gitCommand(candidate, [
				'merge-base',
				'--is-ancestor',
				root.head,
				rootBranch,
			]).exitCode === 0,
		);
		check(
			'combine first parent',
			git(candidate, 'rev-parse', `${combineCommit}^1`) === root.head,
		);
		const baseline = new Map<string, TreeEntry>();
		for (const repo of repos)
			if (repo.head)
				for (const e of tree(repo.copy, repo.head)) {
					const path =
						repo.kind === 'root' ? e.path : `${repo.prefix}/${e.path}`;
					baseline.set(path, { ...e, path });
				}
		const actualTree = new Map(combinedEntries.map((e) => [e.path, e]));
		const pendingWorkingChanges: {
			path: string;
			oldBlob: string | null;
			newBlob: string | null;
		}[] = [];
		const lfsRepresentationChanges: {
			path: string;
			oldBlob: string;
			newBlob: string;
			oid: string;
			size: number;
		}[] = [];
		const newlyUntrackedPreviouslyTracked: string[] = [];
		const structuralChanges: string[] = [];
		const unexplained: string[] = [];
		for (const path of new Set([...baseline.keys(), ...actualTree.keys()])) {
			const old = baseline.get(path),
				next = actualTree.get(path);
			if (old?.oid === next?.oid && old?.mode === next?.mode) continue;
			if (
				path === manifestPath ||
				path === 'repositories.json' ||
				path === '.gitignore'
			) {
				structuralChanges.push(path);
				continue;
			}
			const repo = repoFor(path.replace(/^(apps\/[^/]+)\/code\//, '$1/'));
			const theme = old && themes.get(`${repo.label}:${old.oid}`);
			if (
				old &&
				next &&
				theme &&
				old.mode === '120000' &&
				next.oid === theme.newBlob
			) {
				structuralChanges.push(path);
				continue;
			}
			if (old && next && old.type === 'blob' && next.type === 'blob') {
				const p = pointer(gitInput(candidate, ['cat-file', 'blob', next.oid]));
				const bytes = gitInput(candidate, ['cat-file', 'blob', old.oid]);
				if (p && p.oid === hash(bytes) && p.size === bytes.length) {
					lfsRepresentationChanges.push({
						path,
						oldBlob: old.oid,
						newBlob: next.oid,
						...p,
					});
					continue;
				}
			}
			if (
				old &&
				!next &&
				stat(join(candidate, path)) &&
				tryGit(candidate, 'check-ignore', '--no-index', path)
			) {
				newlyUntrackedPreviouslyTracked.push(path);
				continue;
			}
			// Compare disk bytes to the old HEAD: these differences are the stopped copy's pending edits.
			const disk = stat(join(candidate, path));
			let diskOid: string | null = null;
			if (disk?.isFile())
				diskOid = gitInput(
					candidate,
					['hash-object', '--stdin'],
					readFileSync(join(candidate, path)),
				)
					.toString()
					.trim();
			else if (disk?.isSymbolicLink())
				diskOid = gitInput(
					candidate,
					['hash-object', '--stdin'],
					readlinkSync(join(candidate, path)),
				)
					.toString()
					.trim();
			if (
				!old ||
				!disk ||
				diskOid !== old.oid ||
				(disk.isFile() &&
					((disk.mode & 0o111) !== 0) !== (old.mode === '100755'))
			) {
				pendingWorkingChanges.push({
					path,
					oldBlob: old?.oid ?? null,
					newBlob: next?.oid ?? null,
				});
			} else unexplained.push(path);
		}
		check(
			'combine differences explained',
			unexplained.length === 0,
			unexplained,
		);
		const workingFailures: string[] = [];
		for (const e of expectedWorking) {
			const path = join(candidate, e.path);
			const info = stat(path);
			if (!info) {
				workingFailures.push(e.path);
				continue;
			}
			if (
				e.type === 'file' &&
				(!info.isFile() ||
					hash(readFileSync(path)) !== e.sha256 ||
					(info.mode & 0o7777) !== e.mode)
			)
				workingFailures.push(e.path);
			if (
				e.type === 'symlink' &&
				(!info.isSymbolicLink() || readlinkSync(path) !== e.link)
			)
				workingFailures.push(e.path);
			if (
				e.type === 'directory' &&
				(!info.isDirectory() || (info.mode & 0o7777) !== e.mode)
			)
				workingFailures.push(e.path);
		}
		const allowedWorkingPaths = new Set(
			expectedWorking.map((entry) => entry.path),
		);
		for (const path of [...allowedWorkingPaths, manifestPath]) {
			let parent = posix.dirname(path);
			while (parent !== '.') {
				allowedWorkingPaths.add(parent);
				parent = posix.dirname(parent);
			}
		}
		allowedWorkingPaths.add(manifestPath);
		for (const entry of manifest(candidate).entries)
			if (
				!entry.path.split('/').includes('.git') &&
				!allowedWorkingPaths.has(entry.path)
			)
				workingFailures.push(entry.path);
		check(
			'mapped working bytes and modes',
			workingFailures.length === 0,
			workingFailures,
		);
		const nested = manifest(candidate)
			.entries.filter((e) => basename(e.path) === '.git' && e.path !== '.git')
			.map((e) => e.path);
		check(
			'one .git and no current gitlinks',
			nested.length === 0 && !combinedEntries.some((e) => e.mode === '160000'),
			nested,
		);
		check(
			'candidate fsck',
			gitCommand(candidate, ['fsck', '--no-dangling']).exitCode === 0,
		);
		const candidateObjects = reachable(candidate, combineCommit);
		const candidateSizes = lines(
			gitInput(
				candidate,
				['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
				`${candidateObjects.map(([oid]) => oid).join('\n')}\n`,
			).toString(),
		);
		const missingPayloads: string[] = [];
		const candidateObjectPaths = new Map(candidateObjects);
		for (const [oid, bytes] of smallBlobs(candidate, candidateSizes)) {
			const p = pointer(
				bytes,
				`candidate: blob ${oid}, path ${candidateObjectPaths.get(oid) || '<direct ref>'}`,
			);
			if (!p) continue;
			const path = join(
				candidate,
				'.git/lfs/objects',
				p.oid.slice(0, 2),
				p.oid.slice(2, 4),
				p.oid,
			);
			if (
				!stat(path)?.isFile() ||
				lstatSync(path).size !== p.size ||
				hash(readFileSync(path)) !== p.oid
			)
				missingPayloads.push(p.oid);
		}
		check(
			'all candidate LFS payloads',
			missingPayloads.length === 0,
			missingPayloads,
		);
		const publicationBlockers: {
			repo: string;
			ref: string;
			commit: string;
			path: string;
			blob: string;
		}[] = [];
		const publishedRefs = lines(
			git(candidate, 'for-each-ref', '--format=%(refname) %(objectname)'),
		)
			.map((line) => {
				const [name = '', oid = ''] = line.split(' ');
				return { name, oid };
			})
			.filter(
				(ref) =>
					ref.name === root.symbolic || ref.name.startsWith(`${namespace}/`),
			);
		const publishedCommits = new Set<string>();
		for (const ref of publishedRefs) {
			const peeled = git(candidate, 'rev-parse', `${ref.oid}^{}`);
			const type = git(candidate, 'cat-file', '-t', peeled);
			if (type === 'commit') {
				for (const commit of lines(git(candidate, 'rev-list', peeled)))
					publishedCommits.add(commit);
			} else if (type === 'tree') {
				for (const entry of tree(candidate, peeled).filter((entry) =>
					localPath(entry.path),
				))
					publicationBlockers.push({
						repo: ref.name.includes('/original/')
							? (ref.name.split('/original/')[1]?.split('/')[0] ?? 'candidate')
							: 'candidate',
						ref: ref.name,
						commit: peeled,
						path: entry.path,
						blob: entry.oid,
					});
			}
		}
		for (const commit of publishedCommits) {
			const secrets = tree(candidate, commit).filter((entry) =>
				localPath(entry.path),
			);
			if (!secrets.length) continue;
			const refs = lines(
				git(
					candidate,
					'for-each-ref',
					`--contains=${commit}`,
					'--format=%(refname)',
				),
			).filter((name) => publishedRefs.some((ref) => ref.name === name));
			for (const ref of refs)
				for (const entry of secrets)
					publicationBlockers.push({
						repo: ref.includes('/original/')
							? (ref.split('/original/')[1]?.split('/')[0] ?? 'candidate')
							: ref.includes('/relocated/')
								? (ref.split('/relocated/')[1]?.split('/')[0] ?? 'candidate')
								: 'candidate',
						ref,
						commit,
						path: entry.path,
						blob: entry.oid,
					});
		}
		const publicationCommands = [
			`git -C ${JSON.stringify(candidate)} remote add origin <verified-origin>`,
			`git push origin ${rootBranch}`,
			`git push origin '${namespace}/*:${namespace}/*'`,
			'git lfs push --all origin',
			`git fetch origin '${namespace}/*:${namespace}/*'`,
		];
		report = {
			...manifestData,
			namespace,
			source,
			out,
			candidate,
			status: verification.every((item) => item.passed) ? 'success' : 'failed',
			combineCommit,
			oldOrigin:
				root.remotes.find((remote) => remote.key === 'remote.origin.url')
					?.url ?? null,
			globalHooksPathConfigured,
			verification,
			sourceManifestHash: hash(Buffer.from(JSON.stringify(before))),
			sourceEntries: before.entries.length,
			archiveManifests: repos.map((repo) => ({
				label: repo.label,
				sha256: hash(
					Buffer.from(
						JSON.stringify(
							manifest(join(out, 'originals', `${repo.label}.git`), true),
						),
					),
				),
				entries: manifest(join(out, 'originals', `${repo.label}.git`), true)
					.entries.length,
			})),
			bundles: bundleReports,
			excludedCaches: before.excluded,
			omittedSpecialFiles: before.entries
				.filter((e) => e.type === 'special')
				.map((e) => e.path),
			staleGuidance: ['AGENTS.md', 'EPICENTER.md'],
			localSecretOccurrences,
			publicationBlockers,
			pendingWorkingChanges,
			lfsRepresentationChanges,
			newlyUntrackedPreviouslyTracked,
			structuralChanges,
			publicationCommands,
		};
		writeReports(out, report);
		if (report.status === 'success')
			rmSync(join(out, 'work'), { recursive: true, force: true });
		return { exitCode: report.status === 'success' ? 0 : 1, report };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report = {
			...report,
			status: building ? 'failed' : 'refused',
			source,
			out,
			error: message,
			verification,
		};
		if (building) writeReports(out, report);
		return { exitCode: building ? 1 : 2, report };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
function writeReports(out: string, report: Record<string, unknown>) {
	const items = (key: string) =>
		Array.isArray(report[key]) ? (report[key] as unknown[]) : [];
	const repositories = items('repositories') as {
		label: string;
		HEAD: { oid: string | null };
	}[];
	const rootHead =
		repositories.find((repo) => repo.label === 'root')?.HEAD.oid ?? 'unknown';
	const verification = items('verification') as {
		check: string;
		passed: boolean;
		paths?: string[];
	}[];
	const bundleExclusions = (
		items('bundles') as { excluded: string[] }[]
	).reduce((count, bundle) => count + bundle.excluded.length, 0);
	const summary = [
		`Capture: ${report.capture ?? 'unknown'}`,
		`Namespace: ${report.namespace ?? 'unknown'}`,
		`Candidate: ${report.candidate ?? 'unknown'}`,
		`Combine commit: ${report.combineCommit ?? 'unknown'}`,
		`Root original HEAD: ${rootHead}`,
		'',
		'Verification:',
		'',
		...verification.map(
			(item) =>
				`- ${item.passed ? 'PASS' : 'FAIL'}: ${item.check}${item.paths?.length ? ` (${item.paths.map((path) => JSON.stringify(path)).join(', ')})` : ''}`,
		),
		'',
		'Counts (paths and object hashes in report.json):',
		'',
		...[
			'publicationBlockers',
			'pendingWorkingChanges',
			'lfsRepresentationChanges',
			'newlyUntrackedPreviouslyTracked',
			'themeTransformations',
			'excludedCaches',
			'omittedSpecialFiles',
			'historicalGitlinks',
		].map((key) => `- ${key}: ${items(key).length}`),
		`- bundle exclusions: ${bundleExclusions}`,
	].join('\n');
	writeFileSync(
		join(out, 'report.json'),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	writeFileSync(
		join(out, 'REPORT.md'),
		`# Stopped-copy migration\n\nStatus: ${report.status}\n\n${summary}\n\nDo not publish the namespace until publication blockers in report.json have been reviewed. Deleting a file later does not remove it from history.\n\nAGENTS.md and EPICENTER.md require coordinator rewrite before live use.\n\nCombine commit and relocated objects are unsigned. Original signed objects remain unchanged. Older stash reflogs, index, hooks, configuration, other reflogs and unreachable objects are archive-only in originals/. Bundles include all refs supported by this Git version; any exclusions are explicit in report.json and preserved by original anchors and archives.\n\nGlobal core.hooksPath configured: ${report.globalHooksPathConfigured ?? 'unknown'}; a global override bypasses candidate hooks.\n\nPublication (after origin and blockers are verified; no force):\n\n\`\`\`sh\n${((report.publicationCommands as string[] | undefined) ?? []).join('\n')}\n\`\`\`\n\nThe final fetch command is for existing clones to fetch the namespace explicitly.\n\nSelected-path recovery:\n\n\`\`\`sh\ngit restore --source=<relocated-code-commit> -- apps/<name>/code/\ngit restore --source=<relocated-data-commit> -- apps/<name>/data/\n\`\`\`\n\nRestoring whole apps/<name>/ from a pre-combine commit removes its sibling. Keep originals/, bundles/, maps/, and reports for recovery. Paths, object hashes, verification results, and sanitized origins are in report.json.\n${report.error ? `\nFailure: ${report.error}\n` : ''}`,
	);
}
if (import.meta.main) {
	try {
		const { values } = parseArgs({
			args: Bun.argv.slice(2),
			options: {
				source: { type: 'string' },
				out: { type: 'string' },
				'filter-repo': { type: 'string' },
				json: { type: 'boolean' },
			},
			strict: true,
		});
		if (!values.source || !values.out)
			fail(
				'Usage: bun migrate-to-one-repository.ts --source <stopped-copy> --out <new-or-empty-dir> [--filter-repo <executable>] [--json]',
			);
		const result = migrate({
			source: values.source,
			out: values.out,
			filterRepo: values['filter-repo'],
		});
		if (values.json) process.stdout.write(`${JSON.stringify(result.report)}\n`);
		else
			process.stdout.write(
				`${result.report.status}: ${result.report.error ?? join(values.out, 'REPORT.md')}\n`,
			);
		process.exitCode = result.exitCode;
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
	}
}
