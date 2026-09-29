import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const appRoot = new URL('../', import.meta.url).pathname;
const fixture = await mkdtemp(join(tmpdir(), 'epicenter-field-notebook-'));
const desktopRoot = join(fixture, 'desktop');
const account = 'trip-archive';
const accountRoot = join(desktopRoot, 'Epicenter/accounts', account);
const note = 'so.epicenter.demo.notes/notes/n1~field-visit.md';
const photo = 'so.epicenter.demo.files/files/f1~photo.jpg';
const image = await readFile(join(appRoot, 'fixtures/photo.jpg'));
const browserPort = 21000 + Math.floor(Math.random() * 10000);
const desktopPort = browserPort + 1;
const remote = `http://127.0.0.1:${desktopPort}/repo.git`;
const bun = process.execPath;
const desktop = Bun.spawn([bun, 'src/desktop.ts', accountRoot], {
	cwd: appRoot,
	env: { ...process.env, FILE_NOTEBOOK_PORT: String(desktopPort) },
	stdout: 'pipe',
	stderr: 'pipe',
});
const vite = Bun.spawn(
	[
		bun,
		'x',
		'vite',
		'--host',
		'127.0.0.1',
		'--port',
		String(browserPort),
		'--strictPort',
	],
	{
		cwd: appRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	},
);

async function ready(url: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			await fetch(url)
				.then((response) => response.ok)
				.catch(() => false)
		)
			return;
		await Bun.sleep(100);
	}
	throw new Error(`Server did not start: ${url}`);
}

async function run(args: string[], cwd = desktopRoot) {
	const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode) throw new Error(`${args.join(' ')}: ${stderr}`);
	return stdout;
}

const browser = await chromium.launch({ headless: true });
try {
	await Promise.all([
		ready(`http://127.0.0.1:${browserPort}`),
		ready(`http://127.0.0.1:${desktopPort}/api/location`),
	]);
	const hostile = await fetch(`http://127.0.0.1:${desktopPort}/api/terminal`, {
		method: 'POST',
		headers: {
			Origin: 'https://unrelated.example',
			'Content-Type': 'text/plain',
		},
		body: JSON.stringify({
			command: `touch '${join(fixture, 'hostile-ran')}'`,
		}),
	});
	if (
		hostile.status !== 403 ||
		(await Bun.file(join(fixture, 'hostile-ran')).exists())
	)
		throw new Error('Desktop terminal accepted a cross-origin command');
	if (
		(await fetch(`http://127.0.0.1:${desktopPort}/api/terminal?command=touch`))
			.status !== 405
	)
		throw new Error('Desktop terminal accepted GET');
	const context = await browser.newContext({ acceptDownloads: true });
	await context.addInitScript(
		({ url, account }) => {
			localStorage.setItem('fileNotebookRemote', url);
			if (!localStorage.getItem('fileNotebookAccount'))
				localStorage.setItem('fileNotebookAccount', account);
		},
		{ url: remote, account },
	);
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${browserPort}`);
	await page.getByText('Browser: IndexedDB current files').waitFor();
	await page.locator('#photo').setInputFiles({
		name: 'photo.jpg',
		mimeType: 'image/jpeg',
		buffer: image,
	});
	await page.getByRole('button', { name: 'Create photo row' }).click();
	await page
		.locator('#status')
		.getByText('Created', { exact: false })
		.waitFor();
	await page.locator('#tree').getByRole('button', { name: photo }).click();
	await page.waitForFunction(
		() =>
			(document.querySelector('#preview') as HTMLImageElement)?.naturalWidth ===
			2,
	);
	await page.getByRole('button', { name: 'Create note' }).click();
	await page.locator('#note-path').getByText(note, { exact: true }).waitFor();
	await page.locator('#weather').fill('sunny');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.locator('#status').getByText('Saved kv.json').waitFor();
	await page.locator('#command').fill(`cat ${note}`);
	await page.getByRole('button', { name: 'Run' }).click();
	await page
		.locator('#terminal-output')
		.getByText('Field visit', { exact: false })
		.waitFor();
	await page
		.locator('#command')
		.fill(`sed -i 's/Field visit/Shell visit/' ${note}`);
	await page.getByRole('button', { name: 'Run' }).click();
	await page.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Shell visit',
	);
	await page.locator('#title').fill('App visit');
	await page.getByRole('button', { name: 'Save title' }).click();
	await page.locator('#status').getByText('Saved title in Markdown').waitFor();
	await page.reload();
	await page.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'App visit',
	);
	await page.waitForFunction(
		() =>
			(document.querySelector('#weather') as HTMLInputElement)?.value ===
			'sunny',
	);
	for (const [command, expected] of [
		[`cat ${note}`, 'App visit'],
		['cat so.epicenter.demo.notes/kv.json', 'sunny'],
	] as const) {
		await page.locator('#command').fill(command);
		await page.getByRole('button', { name: 'Run' }).click();
		await page
			.locator('#terminal-output')
			.getByText(expected, { exact: false })
			.waitFor();
	}
	await page.locator('#command').fill(`base64 ${photo}`);
	await page.getByRole('button', { name: 'Run' }).click();
	await page
		.locator('#terminal-output')
		.getByText(image.toString('base64').slice(0, 32), { exact: false })
		.waitFor();
	let releaseUpload!: () => void;
	let uploadSeen!: () => void;
	const uploadGate = new Promise<void>((resolve) => {
		releaseUpload = resolve;
	});
	const sawUpload = new Promise<void>((resolve) => {
		uploadSeen = resolve;
	});
	await page.route('**/lfs/objects/*', async (route) => {
		if (route.request().method() === 'PUT') {
			uploadSeen();
			await uploadGate;
		}
		await route.continue();
	});
	await page.getByRole('button', { name: 'Commit' }).click();
	await sawUpload;
	await page.evaluate(async () => {
		const modulePath = '/src/browser-files.ts';
		const { openBrowserFiles } = (await import(
			modulePath
		)) as typeof import('./browser-files.js');
		const files = await openBrowserFiles('demo-account');
		const source = await files.read(
			'so.epicenter.demo.notes/notes/n1~field-visit.md',
		);
		if (!source) throw new Error('Note disappeared during commit');
		await files.replace(
			source,
			new TextEncoder().encode(
				new TextDecoder()
					.decode(source.bytes)
					.replace('App visit', 'During commit'),
			),
		);
	});
	releaseUpload();
	await page.locator('#status').getByText('Commit', { exact: false }).waitFor();
	await page
		.locator('#git-status')
		.getByText('differ from last commit', { exact: false })
		.waitFor();
	await page.evaluate(async () => {
		const modulePath = '/src/browser-files.ts';
		const { openBrowserFiles } = (await import(
			modulePath
		)) as typeof import('./browser-files.js');
		const files = await openBrowserFiles('demo-account');
		const source = await files.read(
			'so.epicenter.demo.notes/notes/n1~field-visit.md',
		);
		if (!source) throw new Error('Note disappeared after commit');
		await files.replace(
			source,
			new TextEncoder().encode(
				new TextDecoder()
					.decode(source.bytes)
					.replace('During commit', 'App visit'),
			),
		);
	});
	await page
		.locator('#git-status')
		.getByText('No uncommitted file changes')
		.waitFor();
	await page.getByRole('button', { name: 'Push' }).click();
	await page.locator('#status').getByText('push complete').waitFor();

	const desktopPage = await context.newPage();
	await desktopPage.goto(`http://127.0.0.1:${desktopPort}`);
	await desktopPage.getByText('Desktop: ordinary native files').waitFor();
	await desktopPage.getByRole('button', { name: 'Pull' }).click();
	await desktopPage.locator('#status').getByText('pull complete').waitFor();
	const nativePhoto = await readFile(join(accountRoot, photo));
	if (!nativePhoto.equals(image))
		throw new Error('Native LFS image bytes differ');
	const pointer = await run([
		'git',
		'show',
		`HEAD:Epicenter/accounts/${account}/${photo}`,
	]);
	if (!pointer.startsWith('version https://git-lfs.github.com/spec/v1\n'))
		throw new Error('Git did not commit an LFS pointer');
	const before = await run([
		'/bin/bash',
		'-lc',
		`cat '${join(accountRoot, note)}'`,
	]);
	if (!before.includes('App visit'))
		throw new Error('Native Bash did not read browser note');
	await run([
		'/bin/bash',
		'-lc',
		`perl -0pi -e 's/App visit/Native edit/' '${join(accountRoot, note)}'`,
	]);
	await desktopPage.getByRole('button', { name: 'Commit' }).click();
	await desktopPage
		.locator('#status')
		.getByText('Field notebook desktop edit', { exact: false })
		.waitFor();
	await writeFile(
		join(desktopRoot, 'outside.txt'),
		'outside selected account folder\n',
	);
	await run(['git', 'add', '--', 'outside.txt']);
	await run(['git', 'commit', '-m', 'Keep unrelated repository file']);
	await desktopPage.getByRole('button', { name: 'Push' }).click();
	await desktopPage.locator('#status').getByText('push complete').waitFor();
	await page.getByRole('button', { name: 'Pull' }).click();
	await page.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Native edit',
	);
	const browserStatus = await page.locator('#git-status').textContent();
	if (!browserStatus?.includes('No uncommitted'))
		throw new Error('Browser Pull left current files out of sync with HEAD');

	const unknown = await page.evaluate(async () => {
		const modulePath = '/src/browser-files.ts';
		const { openBrowserFiles } = (await import(
			modulePath
		)) as typeof import('./browser-files.js');
		const viewPath = '/src/views.ts';
		const { notesDefinition, openFileStore } = (await import(
			viewPath
		)) as typeof import('./views.js');
		const files = await openBrowserFiles('demo-account');
		const encoder = new TextEncoder();
		const malformedPath = 'so.epicenter.demo.notes/notes/n2~malformed.md';
		const foreignPath = 'so.epicenter.demo.notes/unknown.bin';
		await files.create(
			malformedPath,
			encoder.encode('---\ninvalid: [\n---\nRaw\n'),
		);
		await files.create(foreignPath, Uint8Array.of(0, 255, 11));
		const malformed = (await files.read(malformedPath))?.bytes;
		const foreign = (await files.read(foreignPath))?.bytes;
		const current = await files.read(
			'so.epicenter.demo.notes/notes/n1~field-visit.md',
		);
		if (!current) throw new Error('Note missing');
		const expanded = await files.replace(
			current,
			encoder.encode(
				new TextDecoder()
					.decode(current.bytes)
					.replace('title:', 'unfamiliar: 42\ntitle:'),
			),
		);
		const notes = openFileStore(notesDefinition, files);
		await notes.setField(expanded, 'title', 'Native edit');
		await notes.setKv('weather', 'sunny');
		if (
			JSON.stringify(
				Array.from((await files.read(malformedPath))?.bytes ?? []),
			) !== JSON.stringify(Array.from(malformed ?? []))
		)
			throw new Error('Malformed source changed');
		if (
			JSON.stringify(
				Array.from((await files.read(foreignPath))?.bytes ?? []),
			) !== JSON.stringify(Array.from(foreign ?? []))
		)
			throw new Error('Unfamiliar source changed');
		if (
			!new TextDecoder()
				.decode((await files.read(current.path))?.bytes)
				.includes('unfamiliar: 42')
		)
			throw new Error('Unknown field changed');
		return (await files.snapshot()).map((file) => [
			file.path,
			Array.from(file.bytes),
		]);
	});
	await page.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Native edit',
	);
	await page.getByRole('button', { name: 'Commit' }).click();
	await page.locator('#status').getByText('Commit', { exact: false }).waitFor();
	await page.getByRole('button', { name: 'Push' }).click();
	await page.locator('#status').getByText('push complete').waitFor();
	await run(['git', 'fetch', 'origin', 'main']);
	if (
		(await run(['git', 'show', 'FETCH_HEAD:outside.txt'])) !==
		'outside selected account folder\n'
	)
		throw new Error('Browser commit discarded unrelated Git file');

	const divergent = await browser.newContext();
	await divergent.addInitScript(
		({ url, account }) => {
			localStorage.setItem('fileNotebookRemote', url);
			localStorage.setItem('fileNotebookAccount', account);
		},
		{ url: remote, account },
	);
	const divergentPage = await divergent.newPage();
	await divergentPage.goto(`http://127.0.0.1:${browserPort}`);
	await divergentPage.getByRole('button', { name: 'Pull' }).click();
	await divergentPage.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Native edit',
	);
	await divergentPage.locator('#title').fill('Unsent browser edit');
	await divergentPage.getByRole('button', { name: 'Save title' }).click();
	await divergentPage.locator('#status').getByText('Saved title').waitFor();
	await divergentPage.getByRole('button', { name: 'Commit' }).click();
	await divergentPage
		.locator('#status')
		.getByText('Commit', { exact: false })
		.waitFor();
	await divergentPage.getByRole('button', { name: 'Pull' }).click();
	await divergentPage.locator('#status').getByText('pull complete').waitFor();
	await divergentPage.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Unsent browser edit',
	);
	await desktopPage.getByRole('button', { name: 'Pull' }).click();
	await desktopPage.locator('#status').getByText('pull complete').waitFor();
	await writeFile(
		join(desktopRoot, 'outside.txt'),
		'advanced remote without changing account\n',
	);
	await run(['git', 'add', '--', 'outside.txt']);
	await run(['git', 'commit', '-m', 'Advance remote outside account']);
	await run(['git', 'push', 'origin', 'main']);
	await divergentPage.getByRole('button', { name: 'Pull' }).click();
	await divergentPage
		.locator('#status')
		.getByText('divergent commits', { exact: false })
		.waitFor();
	await page.getByRole('button', { name: 'Pull' }).click();
	await page.locator('#status').getByText('pull complete').waitFor();
	await divergent.close();

	await run([
		'/bin/bash',
		'-lc',
		`perl -0pi -e 's/Native edit/Unsent desktop edit/' '${join(accountRoot, note)}'`,
	]);
	await desktopPage.getByRole('button', { name: 'Commit' }).click();
	await desktopPage
		.locator('#status')
		.getByText('Field notebook desktop edit', { exact: false })
		.waitFor();
	await desktopPage.getByRole('button', { name: 'Pull' }).click();
	await desktopPage.locator('#status').getByText('pull complete').waitFor();
	if (
		!(await readFile(join(accountRoot, note), 'utf8')).includes(
			'Unsent desktop edit',
		)
	)
		throw new Error('Desktop Pull discarded unsent edit');
	const renamed = 'trip-renamed';
	await page.locator('#account-label').fill(renamed);
	await page.getByRole('button', { name: 'Use label' }).click();
	await page.getByText(`Epicenter/accounts/${renamed}`).waitFor();
	await page.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Native edit',
	);
	await page.locator('#command').fill('pwd');
	await page.getByRole('button', { name: 'Run' }).click();
	await page
		.locator('#terminal-output')
		.getByText(`/Epicenter/accounts/${renamed}`)
		.waitFor();
	await page.getByRole('button', { name: 'Commit' }).click();
	await page.locator('#status').getByText('Commit', { exact: false }).waitFor();
	await page.getByRole('button', { name: 'Push' }).click();
	await page.locator('#status').getByText('push complete').waitFor();
	await run(['git', 'fetch', 'origin', 'main']);
	if (
		!(await run([
			'git',
			'show',
			`FETCH_HEAD:Epicenter/accounts/${renamed}/${note}`,
		]).then((text) =>
			text.includes('../../so.epicenter.demo.files/files/f1~photo.jpg'),
		))
	) {
		throw new Error('Renamed account lost the relative photo link');
	}
	if (
		(
			await run([
				'git',
				'ls-tree',
				'-r',
				'FETCH_HEAD',
				'--',
				`Epicenter/accounts/${account}`,
			])
		).trim()
	)
		throw new Error('Renamed account left the old account folder in Git');
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download ZIP' }).click();
	const download = await downloadPromise;
	const archive = await readFile(await download.path());
	await context.close();
	desktop.kill();

	const recovered = await browser.newContext();
	const copyPage = await recovered.newPage();
	await copyPage.goto(`http://127.0.0.1:${browserPort}`);
	await copyPage.getByText('Browser: IndexedDB current files').waitFor();
	await copyPage.locator('#import').setInputFiles({
		name: 'account-files.zip',
		mimeType: 'application/zip',
		buffer: archive,
	});
	await copyPage.locator('#status').getByText('Opened ZIP').waitFor();
	await copyPage.waitForFunction(
		() =>
			(document.querySelector('#title') as HTMLInputElement)?.value ===
			'Native edit',
	);
	await copyPage.waitForFunction(
		() =>
			(document.querySelector('#weather') as HTMLInputElement)?.value ===
			'sunny',
	);
	await copyPage.locator('#tree').getByRole('button', { name: photo }).click();
	await copyPage.waitForFunction(
		() =>
			(document.querySelector('#preview') as HTMLImageElement)?.naturalWidth ===
			2,
	);
	const recovery = await copyPage.evaluate(async () => {
		const modulePath = '/src/browser-files.ts';
		const { openBrowserFiles } = (await import(
			modulePath
		)) as typeof import('./browser-files.js');
		const files = await openBrowserFiles('demo-account');
		const image = await files.read(
			'so.epicenter.demo.files/files/f1~photo.jpg',
		);
		const snapshot = await files.snapshot();
		const note = await files.read(
			'so.epicenter.demo.notes/notes/n1~field-visit.md',
		);
		const link = /!\[Photo\]\(([^)]+)\)/.exec(
			new TextDecoder().decode(note?.bytes),
		);
		if (!link) throw new Error('Recovered note lost its image link');
		const relative = new URL(
			link[1]!,
			'https://account.invalid/so.epicenter.demo.notes/notes/n1~field-visit.md',
		).pathname.slice(1);
		if (relative !== image?.path)
			throw new Error('Recovered relative image link points elsewhere');
		return {
			bytes: Array.from(image?.bytes ?? []),
			paths: snapshot.map((file) => file.path),
			snapshot: snapshot.map((file) => [file.path, Array.from(file.bytes)]),
		};
	});
	if (JSON.stringify(recovery.bytes) !== JSON.stringify([...image]))
		throw new Error('Independent copy lost image bytes');
	if (!recovery.paths.includes('so.epicenter.demo.notes/notes/n2~malformed.md'))
		throw new Error('Independent copy lost malformed source');
	if (!recovery.paths.includes('so.epicenter.demo.notes/unknown.bin'))
		throw new Error('Independent copy lost unfamiliar source');
	if (JSON.stringify(recovery.snapshot) !== JSON.stringify(unknown))
		throw new Error('Independent copy changed source bytes');
	console.log(
		JSON.stringify(
			{
				result: 'pass',
				browserPaths: recovery.paths.length,
				imageSha256: createHash('sha256').update(image).digest('hex'),
				gitPointer: pointer.trim(),
				unknownFilesBeforeCopy: unknown.length,
				copyBytes: archive.length,
				independentRecovery: true,
			},
			null,
			2,
		),
	);
	await recovered.close();
} finally {
	await browser.close();
	vite.kill();
	desktop.kill();
	await rm(fixture, { recursive: true, force: true });
}
