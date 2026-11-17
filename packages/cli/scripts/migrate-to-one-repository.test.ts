/**
 * Stopped-copy migration integration tests.
 * Real signed Git histories exercise original anchors, relocation, LFS transfer,
 * selected-path recovery, source immutability, and refusal before output writes.
 */
import { afterAll, expect, test } from 'bun:test';
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
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { migrate } from './migrate-to-one-repository.ts';

const filterCommand =
	process.env.EPICENTER_FILTER_REPO ?? Bun.which('git-filter-repo');
const filterRepo = filterCommand ? resolve(filterCommand) : '';
if (process.env.EPICENTER_FILTER_REPO && !existsSync(filterRepo))
	throw new Error(`EPICENTER_FILTER_REPO does not exist: ${filterRepo}`);

// These offline integration fixtures require both native Git extensions.
if (!filterRepo || !Bun.which('git-lfs')) {
	test.skip('migration integration requires git-filter-repo and git-lfs', () => {});
} else {
	const temporary: string[] = [];
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
		),
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_LFS_SKIP_SMUDGE: '1',
		GIT_AUTHOR_NAME: 'Fixture',
		GIT_AUTHOR_EMAIL: 'fixture@localhost',
		GIT_COMMITTER_NAME: 'Fixture',
		GIT_COMMITTER_EMAIL: 'fixture@localhost',
	};
	function run(args: string[], cwd?: string, input?: string | Buffer) {
		const result = Bun.spawnSync(args, {
			cwd,
			env,
			stdin: input === undefined ? 'ignore' : Buffer.from(input),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (result.exitCode !== 0)
			throw new Error(
				`${args.slice(0, 3).join(' ')}: ${result.stderr.toString()}`,
			);
		return result.stdout.toString().trimEnd();
	}
	function git(cwd: string, ...args: string[]) {
		return run(['git', '-c', 'core.hooksPath=/dev/null', ...args], cwd);
	}
	function temp() {
		const path = mkdtempSync(join(tmpdir(), 'epicenter-migration-test-'));
		temporary.push(path);
		return path;
	}
	function put(
		root: string,
		path: string,
		bytes: string | Buffer,
		mode?: number,
	) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, bytes);
		if (mode !== undefined) chmodSync(full, mode);
	}
	function digest(root: string): string {
		const records: unknown[] = [];
		function walk(path: string) {
			const full = join(root, path),
				s = lstatSync(full);
			records.push([
				path,
				s.mode,
				s.isFile()
					? createHash('sha256').update(readFileSync(full)).digest('hex')
					: s.isSymbolicLink()
						? readlinkSync(full)
						: '',
			]);
			if (s.isDirectory())
				for (const name of readdirSync(full).sort()) walk(join(path, name));
		}
		walk('');
		return JSON.stringify(records);
	}
	function commit(root: string, message: string) {
		git(root, 'add', '-A');
		git(root, 'commit', '-qm', message);
		return git(root, 'rev-parse', 'HEAD');
	}
	function fixture() {
		const base = temp(),
			source = join(base, 'stopped'),
			out = join(base, 'output');
		mkdirSync(source);
		const key = join(base, 'signer');
		run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
		function init(path: string, signed = false) {
			mkdirSync(path, { recursive: true });
			git(path, 'init', '-q', '--initial-branch=main');
			git(path, 'config', 'user.name', 'Fixture');
			git(path, 'config', 'user.email', 'fixture@localhost');
			if (signed) {
				git(path, 'config', 'gpg.format', 'ssh');
				git(path, 'config', 'user.signingkey', key);
				git(path, 'config', 'commit.gpgsign', 'true');
			}
		}
		init(source, true);
		put(source, 'EPICENTER.md', 'Original marker\n');
		put(source, 'AGENTS.md', 'Original guidance\n');
		put(
			source,
			'.gitignore',
			'apps/\n*.local\n*.local.*\nnode_modules/\n.DS_Store\n',
		);
		put(
			source,
			'.gitattributes',
			'*.png filter=lfs diff=lfs merge=lfs -text\n',
		);
		put(source, 'repositories.json', '{"private":"registry bytes"}\n');
		put(source, 'theme.css', 'body {}\n');
		commit(source, 'root one');
		put(source, 'routines/run', 'echo hello\n');
		commit(source, 'root two');
		put(source, 'theme.css', 'body {color: red}\n');
		const rootHead = commit(source, 'root three');
		git(source, 'branch', 'other-root', 'HEAD~1');
		git(source, 'tag', 'root-tag', 'HEAD~1');
		git(
			source,
			'remote',
			'add',
			'origin',
			'https://owner:rootpassword@example.invalid/root.git?auth=hidden',
		);
		mkdirSync(join(source, '.git/worktrees'));
		put(source, 'routines/x.local/value', 'private directory value');
		put(source, 'theme.css', 'body {color: blue}\n');
		const a = join(source, 'apps/A'),
			data = join(a, 'data');
		init(a, true);
		put(a, '.gitignore', 'data/\nnode_modules/\nui/dist/\n');
		put(a, 'epicenter.ts', 'export default {};\n');
		put(a, 'ui/src/place', 'ui');
		symlinkSync('../../../../theme.css', join(a, 'ui/src/theme.css'));
		put(a, 'same-bytes', '../../../../theme.css');
		put(a, 'run', '#!/bin/sh\nexit 0\n', 0o755);
		put(
			a,
			'ordinary.png',
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
		);
		const first = commit(a, 'code first');
		put(a, 'readme', 'next');
		const codeHead = commit(a, 'code second');
		git(a, 'tag', 'light', first);
		git(
			a,
			'-c',
			'tag.gpgsign=false',
			'tag',
			'-a',
			'annotated',
			'-m',
			'annotated',
			first,
		);
		git(a, 'checkout', '-qb', 'feature');
		put(a, 'feature', 'feature branch');
		const feature = commit(a, 'feature');
		git(a, 'checkout', '-q', 'main');
		git(a, 'checkout', '-qb', 'regular-theme');
		rmSync(join(a, 'ui/src/theme.css'));
		put(a, 'ui/src/theme.css', '../../../../theme.css');
		const regular = commit(a, 'regular theme file');
		git(a, 'checkout', '-q', 'main');
		git(a, 'checkout', '-qb', 'remote-fixture');
		put(a, 'remote', 'remote only');
		const remote = commit(a, 'remote only');
		git(a, 'checkout', '-q', 'main');
		git(a, 'update-ref', 'refs/remotes/origin/main', remote);
		git(
			a,
			'symbolic-ref',
			'refs/remotes/origin/HEAD',
			'refs/remotes/origin/main',
		);
		git(a, 'branch', '-D', 'remote-fixture');
		put(a, 'readme', 'stashed edit');
		git(a, 'stash', 'push', '-qm', 'stash edit');
		const stash = git(a, 'rev-parse', 'refs/stash');
		rmSync(join(a, 'ui/src/place'));
		const blob = git(a, 'rev-parse', 'HEAD:same-bytes'),
			tree = git(a, 'rev-parse', 'HEAD^{tree}');
		git(a, 'update-ref', 'refs/fixtures/blob', blob);
		git(a, 'update-ref', 'refs/fixtures/tree', tree);
		git(
			a,
			'remote',
			'add',
			'origin',
			'https://user:password@example.invalid/code.git?token=hidden',
		);
		init(data);
		put(data, '.gitignore', '*.local\n*.local.*\n');
		put(data, 'record', 'original data record', 0o600);
		const payload = Buffer.from('historical LFS media payload'),
			oid = createHash('sha256').update(payload).digest('hex');
		const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`;
		put(data, 'historical.pdf', pointer);
		put(
			data,
			`.git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`,
			payload,
		);
		const dataFirst = commit(data, 'data with media');
		rmSync(join(data, 'historical.pdf'));
		const dataHead = commit(data, 'delete media');
		put(data, 'record', 'pending data edit', 0o600);
		put(data, 'secret.local.json', 'SECRET_VALUE_NEVER_REPORT');
		put(data, 'pending-record', 'RECORD_VALUE_NEVER_REPORT');
		const vault = join(base, 'vault');
		mkdirSync(vault);
		put(vault, 'file', 'vault unchanged');
		symlinkSync(vault, join(data, 'vault'));
		const b = join(source, 'apps/B');
		init(b);
		put(b, '.gitignore', 'data/\n');
		put(b, 'epicenter.ts', 'export default {};');
		commit(b, 'B code');
		init(join(b, 'data'));
		put(join(b, 'data'), '.gitignore', '*.local\n*.local.*\n');
		put(join(b, 'data'), 'item', 'B record');
		commit(join(b, 'data'), 'B data');
		return {
			base,
			source,
			out,
			a,
			data,
			rootHead,
			codeHead,
			first,
			feature,
			regular,
			remote,
			stash,
			blob,
			tree,
			oid,
			payload,
			dataFirst,
			dataHead,
			vault,
		};
	}
	afterAll(() => {
		for (const path of temporary)
			rmSync(path, { recursive: true, force: true });
	});

	// One shared capture covers the costly signed-history and network-free round trip.
	const success = fixture();
	const before = digest(success.source);
	const result = migrate({
		source: success.source,
		out: success.out,
		filterRepo,
	});
	const candidate = join(success.out, 'Epicenter');
	function copyFixture() {
		const base = temp(),
			source = join(base, 'stopped'),
			out = join(base, 'output');
		cpSync(success.source, source, { recursive: true, verbatimSymlinks: true });
		return {
			...success,
			base,
			source,
			out,
			a: join(source, 'apps/A'),
			data: join(source, 'apps/A/data'),
		};
	}
	function report() {
		return JSON.parse(readFileSync(join(success.out, 'report.json'), 'utf8'));
	}

	test('signed histories, every ref, working bytes, and LFS survive the import', () => {
		expect(result.report.error ?? result.report.verification).toBeDefined();
		if (result.exitCode !== 0)
			throw new Error(
				JSON.stringify({
					error: result.report.error,
					failed: (
						result.report.verification as { check: string; passed: boolean }[]
					).filter((c) => !c.passed),
				}),
			);
		expect(result.exitCode).toBe(0);
		expect(digest(success.source)).toBe(before);
		expect(git(candidate, 'rev-parse', 'HEAD^1')).toBe(success.rootHead);
		git(candidate, 'merge-base', '--is-ancestor', success.rootHead, 'main');
		expect(git(candidate, 'cat-file', 'commit', success.rootHead)).toContain(
			'gpgsig -----BEGIN SSH SIGNATURE-----',
		);
		const r = report();
		expect(r.status).toBe('success');
		const markdown = readFileSync(join(success.out, 'REPORT.md'), 'utf8');
		for (const value of [
			r.capture,
			`refs/tags/epicenter-migration/${r.capture}`,
			candidate,
			r.combineCommit,
			success.rootHead,
		])
			expect(markdown).toContain(value);
		for (const item of r.verification)
			expect(markdown).toContain(
				`${item.passed ? 'PASS' : 'FAIL'}: ${item.check}`,
			);
		for (const key of [
			'publicationBlockers',
			'pendingWorkingChanges',
			'lfsRepresentationChanges',
			'newlyUntrackedPreviouslyTracked',
			'themeTransformations',
			'excludedCaches',
			'omittedSpecialFiles',
			'historicalGitlinks',
		])
			expect(markdown).toContain(`${key}: ${r[key].length}`);
		expect(markdown).toContain('bundle exclusions: 0');

		expect(
			r.verification.every((item: { passed: boolean }) => item.passed),
		).toBe(true);
		for (const repo of r.repositories) {
			for (const ref of repo.refs) {
				expect(git(candidate, 'rev-parse', ref.originalAnchor)).toBe(ref.oid);
				expect(git(candidate, 'cat-file', '-t', ref.originalAnchor)).toBe(
					ref.type,
				);
				if (ref.relocatedAnchor)
					expect(git(candidate, 'rev-parse', `${ref.relocatedAnchor}^{}`)).toBe(
						repo.commitMap[ref.peeled],
					);
			}
			if (repo.HEAD.oid)
				expect(git(candidate, 'rev-parse', repo.headAnchors.original)).toBe(
					repo.HEAD.oid,
				);
		}
		for (const repo of r.repositories)
			expect(digest(join(success.source, repo.oldPath, '.git'))).toBe(
				digest(join(success.out, 'originals', `${repo.label}.git`)),
			);
		const code = r.repositories.find(
			(repo: { label: string }) => repo.label === 'A.code',
		);
		const mainRef = code.refs.find(
			(ref: { name: string }) => ref.name === 'refs/heads/main',
		);
		expect(
			git(candidate, 'cat-file', 'commit', mainRef.originalAnchor),
		).toContain('gpgsig -----BEGIN SSH SIGNATURE-----');
		expect(
			git(candidate, 'cat-file', 'commit', mainRef.relocatedAnchor),
		).not.toContain('gpgsig ');

		expect(
			code.refs.find(
				(ref: { name: string }) => ref.name === 'refs/remotes/origin/HEAD',
			).symref,
		).toBe('refs/remotes/origin/main');
		for (const oid of [
			success.first,
			success.codeHead,
			success.feature,
			success.remote,
			success.stash,
		])
			expect(
				git(
					candidate,
					'show',
					`${code.commitMap[oid]}:apps/A/code/ui/src/theme.css`,
				),
			).toBe('../../../../../theme.css');
		expect(
			git(
				candidate,
				'ls-tree',
				code.commitMap[success.regular],
				'apps/A/code/ui/src/theme.css',
			),
		).toStartWith('100644');
		expect(
			git(
				candidate,
				'show',
				`${code.commitMap[success.regular]}:apps/A/code/ui/src/theme.css`,
			),
		).toBe('../../../../theme.css');
		expect(
			readFileSync(join(candidate, 'apps/A/code/same-bytes'), 'utf8'),
		).toBe('../../../../theme.css');
		expect(readlinkSync(join(candidate, 'apps/A/code/ui/src/theme.css'))).toBe(
			'../../../../../theme.css',
		);
		expect(readlinkSync(join(candidate, 'apps/A/data/vault'))).toBe(
			success.vault,
		);
		expect(readFileSync(join(success.vault, 'file'), 'utf8')).toBe(
			'vault unchanged',
		);
		expect(lstatSync(join(candidate, 'apps/A/code/run')).mode & 0o777).toBe(
			0o755,
		);
		expect(lstatSync(join(candidate, 'apps/A/data/record')).mode & 0o777).toBe(
			0o600,
		);
		expect(existsSync(join(candidate, 'apps/A/data/secret.local.json'))).toBe(
			true,
		);
		expect(git(candidate, 'ls-tree', '-r', 'HEAD')).not.toContain(
			'secret.local.json',
		);
		expect(git(candidate, 'remote')).toBe('');
		expect(git(candidate, 'rev-parse', 'other-root')).toBe(
			git(success.source, 'rev-parse', 'other-root'),
		);
		expect(git(candidate, 'rev-parse', 'root-tag')).toBe(
			git(success.source, 'rev-parse', 'root-tag'),
		);
		expect(r.oldOrigin).toBe('https://example.invalid/root.git');
		expect(
			r.bundles.find((bundle: { repo: string }) => bundle.repo === 'A.code')
				.excluded,
		).toEqual([]);
		expect(existsSync(join(success.out, 'work'))).toBe(false);
		expect(
			r.lfsRepresentationChanges.some(
				(item: { path: string }) => item.path === 'apps/A/code/ordinary.png',
			),
		).toBe(true);
		expect(
			r.pendingWorkingChanges.some(
				(item: { path: string }) => item.path === 'apps/A/data/pending-record',
			),
		).toBe(true);
		expect(
			r.pendingWorkingChanges.some(
				(item: { path: string; oldBlob: string | null }) =>
					item.path === 'apps/A/data/record' && item.oldBlob !== null,
			),
		).toBe(true);
		expect(
			r.pendingWorkingChanges.some(
				(item: { path: string; newBlob: string | null }) =>
					item.path === 'apps/A/code/ui/src/place' && item.newBlob === null,
			),
		).toBe(true);
		expect(readFileSync(join(candidate, 'AGENTS.md'), 'utf8')).toBe(
			'Original guidance\n',
		);
		expect(readFileSync(join(candidate, 'EPICENTER.md'), 'utf8')).toBe(
			'Original marker\n',
		);
		expect(
			readFileSync(
				join(success.out, 'removed-working-files/repositories.json'),
				'utf8',
			),
		).toBe(readFileSync(join(success.source, 'repositories.json'), 'utf8'));
		for (const path of [
			'report.json',
			'REPORT.md',
			`.epicenter-migration/${r.capture}.json`,
		]) {
			const bytes = readFileSync(
				path.startsWith('.') ? join(candidate, path) : join(success.out, path),
				'utf8',
			);
			expect(bytes).not.toContain('SECRET_VALUE_NEVER_REPORT');
			expect(bytes).not.toContain('RECORD_VALUE_NEVER_REPORT');
			expect(bytes).not.toContain('password');
			expect(bytes).not.toContain('rootpassword');
			expect(bytes).not.toContain('token=hidden');
		}
	}, 120000);

	test('fast-forward publication, namespace clone, LFS transfer and selected-path recovery work locally', () => {
		if (result.exitCode !== 0)
			throw new Error(
				`Migration failed: ${JSON.stringify(result.report.error)}`,
			);
		const r = report(),
			origin = join(success.base, 'origin.git'),
			fresh = join(success.base, 'fresh');
		git(success.base, 'init', '--bare', '--initial-branch=main', origin);
		git(candidate, 'push', origin, `${success.rootHead}:refs/heads/main`);
		git(candidate, 'remote', 'add', 'origin', origin);
		git(candidate, 'push', 'origin', 'main');
		const ns = `refs/tags/epicenter-migration/${r.capture}`;
		git(candidate, 'push', 'origin', `${ns}/*:${ns}/*`);
		git(candidate, 'lfs', 'push', '--all', 'origin');
		git(success.base, 'clone', origin, fresh);
		expect(
			git(fresh, 'rev-parse', `${ns}/original/A.code/refs/fixtures/blob`),
		).toBe(success.blob);
		expect(git(fresh, 'cat-file', '-t', success.tree)).toBe('tree');
		for (const repo of r.repositories)
			for (const ref of repo.refs)
				expect(git(fresh, 'cat-file', '-t', ref.oid)).toBe(ref.type);
		git(fresh, 'lfs', 'fetch', '--all', 'origin');
		const payload = join(
			fresh,
			'.git/lfs/objects',
			success.oid.slice(0, 2),
			success.oid.slice(2, 4),
			success.oid,
		);
		expect(readFileSync(payload)).toEqual(success.payload);
		const historicalPointer = git(
			fresh,
			'show',
			`${success.dataFirst}:historical.pdf`,
		);
		const smudged = Bun.spawnSync(
			[
				'git',
				'-c',
				'core.hooksPath=/dev/null',
				'-c',
				'core.autocrlf=false',
				'-c',
				'core.fsmonitor=false',
				'lfs',
				'smudge',
			],
			{
				cwd: fresh,
				env: { ...env, GIT_LFS_SKIP_SMUDGE: '0' },
				stdin: Buffer.from(`${historicalPointer}\n`),
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		expect(smudged.exitCode).toBe(0);
		expect(smudged.stdout).toEqual(success.payload);

		const code = r.repositories.find(
				(repo: { label: string }) => repo.label === 'A.code',
			),
			data = r.repositories.find(
				(repo: { label: string }) => repo.label === 'A.data',
			);
		put(fresh, 'apps/A/data/record', 'modified data');
		git(
			fresh,
			'restore',
			`--source=${code.commitMap[success.first]}`,
			'--',
			'apps/A/code/',
		);
		expect(readFileSync(join(fresh, 'apps/A/data/record'), 'utf8')).toBe(
			'modified data',
		);
		put(fresh, 'apps/A/code/readme', 'modified code');
		git(
			fresh,
			'restore',
			`--source=${data.commitMap[success.dataFirst]}`,
			'--',
			'apps/A/data/',
		);
		expect(readFileSync(join(fresh, 'apps/A/code/readme'), 'utf8')).toBe(
			'modified code',
		);
	}, 120000);

	for (const kind of ['missing', 'wrong size'] as const)
		test(`${kind} historical LFS payload refuses before output writes`, () => {
			const f = copyFixture(),
				payload = join(
					f.data,
					'.git/lfs/objects',
					f.oid.slice(0, 2),
					f.oid.slice(2, 4),
					f.oid,
				);
			if (kind === 'missing') rmSync(payload);
			else {
				const old = readFileSync(
					join(
						f.data,
						'.git/objects',
						git(f.data, 'rev-parse', `${f.dataFirst}:historical.pdf`).slice(
							0,
							2,
						),
						git(f.data, 'rev-parse', `${f.dataFirst}:historical.pdf`).slice(2),
					),
				);
				expect(old.length).toBeGreaterThan(0);
				git(f.data, 'checkout', '-q', '-b', 'wrong-pointer', f.dataFirst);
				put(
					f.data,
					'historical.pdf',
					`version https://git-lfs.github.com/spec/v1\noid sha256:${f.oid}\nsize ${f.payload.length + 1}\n`,
				);
				commit(f.data, 'wrong size');
				git(f.data, 'checkout', '-q', 'main');
			}
			const baseline = digest(f.source),
				r = migrate({ source: f.source, out: f.out, filterRepo });
			expect(r.exitCode).toBe(2);
			expect(String(r.report.error)).toContain('LFS payload');
			expect(existsSync(f.out)).toBe(false);
			expect(digest(f.source)).toBe(baseline);
		}, 120000);

	for (const scenario of [
		'gitlink',
		'gitfile',
		'alternates',
		'embedded',
		'working link',
		'historical link',
		'nonempty',
	] as const)
		test(`${scenario} refuses with a concrete message and preserves the source`, () => {
			const f = copyFixture();
			let message = '';
			switch (scenario) {
				case 'gitlink':
					git(
						f.a,
						'update-index',
						'--add',
						'--cacheinfo',
						`160000,${f.codeHead},submodule`,
					);
					git(f.a, 'commit', '-qm', 'gitlink');
					message = 'gitlink';
					break;
				case 'gitfile':
					rmSync(join(f.data, '.git'), { recursive: true });
					put(f.data, '.git', 'gitdir: somewhere');
					message = 'directory';
					break;
				case 'alternates':
					put(f.a, '.git/objects/info/alternates', '/not/allowed');
					message = 'alternates';
					break;
				case 'embedded':
					mkdirSync(join(f.source, 'drafts/embedded/.git'), {
						recursive: true,
					});
					message = 'embedded repository';
					break;
				case 'working link':
					symlinkSync('../data/record', join(f.a, 'ambiguous'));
					message = 'meaning-changing symlink';
					break;
				case 'historical link':
					symlinkSync('../data/record', join(f.a, 'ambiguous'));
					commit(f.a, 'bad historical link');
					rmSync(join(f.a, 'ambiguous'));
					commit(f.a, 'delete link');
					message = 'meaning-changing symlink';
					break;
				case 'nonempty':
					put(f.out, 'keep', 'keep');
					message = 'out must be empty';
					break;
			}
			const baseline = digest(f.source),
				r = migrate({ source: f.source, out: f.out, filterRepo });
			expect(r.exitCode).toBe(2);
			expect(String(r.report.error)).toContain(message);
			expect(digest(f.source)).toBe(baseline);
			if (scenario === 'nonempty')
				expect(readFileSync(join(f.out, 'keep'), 'utf8')).toBe('keep');
			else expect(existsSync(f.out)).toBe(false);
		}, 120000);

	test('historical local-secret paths become publication blockers with original and relocated refs', () => {
		const f = copyFixture();
		git(f.data, 'checkout', '-qb', 'private-history', f.dataFirst);
		put(f.data, 'archived.local.json', 'HISTORICAL_SECRET_NEVER_REPORT');
		git(f.data, 'add', '-f', 'archived.local.json');
		git(f.data, 'commit', '-qm', 'historical local file');
		git(f.data, 'checkout', '-q', 'main');
		put(f.data, 'head.local.json', 'CURRENT_TRACKED_SECRET_NEVER_REPORT');
		git(f.data, 'add', '-f', 'head.local.json');
		git(f.data, 'commit', '-qm', 'tracked local file');
		const result = migrate({ source: f.source, out: f.out, filterRepo });
		expect(result.exitCode).toBe(0);
		const r = JSON.parse(readFileSync(join(f.out, 'report.json'), 'utf8'));
		expect(
			r.publicationBlockers.some(
				(item: { ref: string; path: string }) =>
					item.ref.includes('/original/A.data/') &&
					item.path === 'archived.local.json',
			),
		).toBe(true);
		expect(
			r.publicationBlockers.some(
				(item: { ref: string; path: string }) =>
					item.ref.includes('/relocated/A.data/') &&
					item.path === 'apps/A/data/archived.local.json',
			),
		).toBe(true);
		expect(readFileSync(join(f.out, 'report.json'), 'utf8')).not.toContain(
			'HISTORICAL_SECRET_NEVER_REPORT',
		);
		expect(r.newlyUntrackedPreviouslyTracked).toContain(
			'apps/A/data/head.local.json',
		);
		expect(readFileSync(join(f.out, 'report.json'), 'utf8')).not.toContain(
			'CURRENT_TRACKED_SECRET_NEVER_REPORT',
		);
	}, 120000);

	for (const scenario of [
		'staged',
		'lock',
		'git storage symlink',
		'gitdir hidden under cache',
		'symlink app',
		'detached root',
		'reserved namespace',
		'absolute source link',
		'unsupported pointer',
	] as const)
		test(`${scenario} refuses in preflight`, () => {
			const f = copyFixture();
			let message = '';
			switch (scenario) {
				case 'unsupported pointer':
					git(f.data, 'checkout', '-qb', 'unsupported-pointer');
					put(
						f.data,
						'unsupported.lfs',
						'version https://git-lfs.github.com/spec/v1\next-unsupported value\noid sha256:' +
							f.oid +
							'\nsize ' +
							f.payload.length +
							'\n',
					);
					commit(f.data, 'unsupported pointer form');
					message = 'pointer form is unsupported';
					break;
				case 'staged':
					put(f.a, 'staged', 'pending index');
					git(f.a, 'add', 'staged');
					message = 'commit or unstage';
					break;
				case 'lock':
					put(f.a, '.git/objects/in-progress.lock', '');
					message = 'lock';
					break;
				case 'git storage symlink':
					symlinkSync('/not/followed', join(f.a, '.git/storage-link'));
					message = 'unsupported Git storage';
					break;
				case 'gitdir hidden under cache':
					mkdirSync(join(f.a, 'ui/dist/embedded/.git'), { recursive: true });
					message = 'embedded repository';
					break;
				case 'symlink app':
					symlinkSync(f.a, join(f.source, 'apps/Alias'));
					message = 'Expected real directory';
					break;
				case 'detached root':
					git(f.source, 'checkout', '--detach', '-q');
					message = 'Root HEAD must be on a branch';
					break;
				case 'reserved namespace':
					git(
						f.source,
						'update-ref',
						'refs/tags/epicenter-migration/previous',
						f.rootHead,
					);
					message = 'Root already contains';
					break;
				case 'absolute source link':
					symlinkSync(join(f.source, 'theme.css'), join(f.a, 'absolute'));
					message = 'absolute link points into source';
					break;
			}
			const baseline = digest(f.source);
			mkdirSync(f.out);
			const r = migrate({ source: f.source, out: f.out, filterRepo });
			expect(r.exitCode).toBe(2);
			expect(String(r.report.error)).toContain(message);
			expect(readdirSync(f.out)).toEqual([]);
			expect(digest(f.source)).toBe(baseline);
		}, 120000);

	test('CLI reports refusal as JSON and exits 2 without touching a nonempty output', () => {
		const f = copyFixture();
		put(f.out, 'keep', 'existing bytes');
		const r = Bun.spawnSync(
			[
				process.execPath,
				resolve(import.meta.dir, 'migrate-to-one-repository.ts'),
				'--source',
				f.source,
				'--out',
				f.out,
				'--filter-repo',
				filterRepo,
				'--json',
			],
			{ env, stdout: 'pipe', stderr: 'pipe' },
		);
		expect(r.exitCode).toBe(2);
		expect(JSON.parse(r.stdout.toString()).status).toBe('refused');
		expect(readFileSync(join(f.out, 'keep'), 'utf8')).toBe('existing bytes');
	});

	test('unborn data history and detached code HEAD are preserved without inventing parents', () => {
		const f = copyFixture();
		// Remove only fixture Git storage, leaving its working records to import.
		rmSync(join(f.source, 'apps/B/data/.git'), { recursive: true });
		git(join(f.source, 'apps/B/data'), 'init', '-q', '--initial-branch=main');
		git(f.a, 'checkout', '--detach', '-q', f.codeHead);
		put(f.a, 'detached', 'detached-only working code');
		const detached = commit(f.a, 'detached code commit');
		const r = migrate({ source: f.source, out: f.out, filterRepo });
		expect(
			r.exitCode === 0 ? r.report : (r.report.error ?? r.report.verification),
		).toBeDefined();
		expect(r.exitCode).toBe(0);
		const report = JSON.parse(readFileSync(join(f.out, 'report.json'), 'utf8'));
		const code = report.repositories.find(
				(repo: { label: string }) => repo.label === 'A.code',
			),
			data = report.repositories.find(
				(repo: { label: string }) => repo.label === 'B.data',
			);
		expect(code.HEAD.symbolic).toBe(null);
		expect(code.HEAD.oid).toBe(detached);
		expect(
			git(join(f.out, 'Epicenter'), 'rev-parse', code.headAnchors.relocated),
		).toBe(code.commitMap[detached]);
		expect(data.HEAD.oid).toBe(null);
		expect(report.combineParents.length).toBe(4);
		expect(
			readFileSync(join(f.out, 'Epicenter/apps/B/data/item'), 'utf8'),
		).toBe('B record');
	}, 120000);
}
