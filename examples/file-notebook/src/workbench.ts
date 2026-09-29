import { openBrowserFiles } from './browser-files.js';
import { openBrowserGit } from './browser-git.js';
import { openBrowserShell } from './browser-shell.js';
import { exportAccountFiles, importEmptyAccountFiles } from './copy.js';
import type { AccountFiles } from './files.js';
import { openRemoteFiles } from './remote-files.js';
import { filesDefinition, notesDefinition, openFileStore } from './views.js';

function element<T extends HTMLElement>(id: string): T {
	const value = document.getElementById(id);
	if (!value) throw new Error(`Missing element: ${id}`);
	return value as T;
}

const status = element<HTMLParagraphElement>('status');
const showError = (error: unknown) => {
	status.textContent = error instanceof Error ? error.message : String(error);
	status.className = 'bad';
};
const info = (message: string) => {
	status.textContent = message;
	status.className = '';
};

async function start() {
	const location = await fetch('/api/location')
		.then(async (response) => {
			if (!response.headers.get('content-type')?.includes('application/json'))
				return false;
			return (await response.json()) as { root: string; account: string };
		})
		.catch(() => false);
	const desktop = typeof location === 'object';
	const account =
		typeof location === 'object'
			? location.account
			: (localStorage.getItem('fileNotebookAccount') ?? 'demo');
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(account))
		throw new Error('Invalid account folder name');
	const browserFiles = desktop
		? undefined
		: await openBrowserFiles('demo-account');
	const files: AccountFiles = desktop ? openRemoteFiles() : browserFiles!;
	const remote =
		localStorage.getItem('fileNotebookRemote') ??
		'http://127.0.0.1:4317/repo.git';
	const browserGit = browserFiles
		? await openBrowserGit(browserFiles, remote, 'demo-account', account)
		: undefined;
	const notes = openFileStore(notesDefinition, files);
	const assets = openFileStore(filesDefinition, files);
	const shell = desktop ? undefined : openBrowserShell(files, account);
	element('account-path').textContent = `Epicenter/accounts/${account}`;
	element<HTMLInputElement>('account-label').value = account;
	element('account-control').style.display = desktop ? 'none' : '';
	element('change-account').onclick = () => {
		const next = element<HTMLInputElement>('account-label').value.trim();
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(next)) {
			showError(
				new Error(
					'Use letters, numbers, underscores, or hyphens for the folder label',
				),
			);
			return;
		}
		localStorage.setItem('fileNotebookAccount', next);
		window.location.reload();
	};
	element('mode').textContent = desktop
		? 'Desktop: ordinary native files'
		: 'Browser: IndexedDB current files';
	let selected = '';
	let titleSource = await files.read(
		`${notesDefinition.id}/notes/n1~field-visit.md`,
	);
	let imageUrl: string | undefined;

	async function refresh() {
		const paths = await files.list();
		const tree = element<HTMLUListElement>('tree');
		tree.replaceChildren(
			...paths.map((path) => {
				const item = document.createElement('li');
				const button = document.createElement('button');
				button.textContent = path;
				button.onclick = () => {
					selected = path;
					void showSource();
				};
				item.append(button);
				return item;
			}),
		);
		const rows = await notes.rows('notes');
		const note = rows.find((row) => row.path.endsWith('/n1~field-visit.md'));
		if (note && 'fields' in note) {
			titleSource = note.source;
			element<HTMLInputElement>('title').value = String(
				note.fields?.title ?? '',
			);
			element('note-path').textContent = note.path;
			element('body').textContent = note.body ?? '';
		} else {
			element('note-path').textContent =
				note?.error ?? 'Create the demo note to begin.';
		}
		try {
			element<HTMLInputElement>('weather').value = String(
				(await notes.kv()).values.weather ?? '',
			);
		} catch (error) {
			showError(error);
		}
		if (selected) await showSource();
		if (desktop) {
			const response = await fetch('/api/git-status');
			const git = await response.json();
			element('git-status').textContent =
				git.stdout || git.stderr || 'Clean working tree';
		} else if (browserGit)
			element('git-status').textContent = await browserGit.status();
	}

	async function showSource() {
		const source = await files.read(selected);
		element('source-path').textContent = selected;
		const preview = element<HTMLImageElement>('preview');
		if (imageUrl) URL.revokeObjectURL(imageUrl);
		imageUrl = undefined;
		preview.style.display = 'none';
		if (!source) {
			element('source').textContent = 'File disappeared';
			return;
		}
		if (/\.(jpg|jpeg|png|webp)$/i.test(selected)) {
			imageUrl = URL.createObjectURL(
				new Blob([source.bytes as BlobPart], { type: 'image/jpeg' }),
			);
			preview.src = imageUrl;
			preview.style.display = 'block';
			element('source').textContent = Array.from(
				source.bytes.slice(0, 32),
				(byte) => byte.toString(16).padStart(2, '0'),
			).join(' ');
		} else {
			try {
				element('source').textContent = new TextDecoder('utf-8', {
					fatal: true,
					ignoreBOM: true,
				}).decode(source.bytes);
			} catch {
				element('source').textContent = `${source.bytes.length} raw bytes`;
			}
		}
	}

	element('create-note').onclick = () =>
		void (async () => {
			try {
				const path = `${notesDefinition.id}/notes/n1~field-visit.md`;
				await notes.createRow(
					'notes',
					path,
					{ title: 'Field visit' },
					`![Photo](../../${filesDefinition.id}/files/f1~photo.jpg)`,
				);
				info(`Created ${path}`);
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	element('create-photo').onclick = () =>
		void (async () => {
			try {
				const photo = element<HTMLInputElement>('photo').files?.[0];
				if (!photo || photo.type !== 'image/jpeg')
					throw new Error('Choose a JPEG photo');
				const path = `${filesDefinition.id}/files/f1~photo.md`;
				await assets.createRow('files', path, { caption: photo.name }, '', {
					path: `${filesDefinition.id}/files/f1~photo.jpg`,
					bytes: new Uint8Array(await photo.arrayBuffer()),
				});
				info(`Created ${path} and its image bytes`);
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	element('save-title').onclick = () =>
		void (async () => {
			try {
				if (!titleSource) throw new Error('Create the note first');
				await notes.setField(
					titleSource,
					'title',
					element<HTMLInputElement>('title').value,
				);
				info('Saved title in Markdown');
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	element('save-weather').onclick = () =>
		void (async () => {
			try {
				await notes.setKv(
					'weather',
					element<HTMLInputElement>('weather').value,
				);
				info('Saved kv.json');
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	element('run').onclick = () =>
		void (async () => {
			try {
				const command = element<HTMLInputElement>('command').value;
				const result = shell
					? await shell.exec(command)
					: await fetch('/api/terminal', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ command }),
						}).then((response) => response.json());
				element('terminal-output').textContent =
					`${result.stdout}${result.stderr}${result.exitCode ? `\nexit ${result.exitCode}` : ''}`;
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	element('export').onclick = () =>
		void (async () => {
			try {
				const archive = await exportAccountFiles(files);
				const url = URL.createObjectURL(
					new Blob([archive as BlobPart], { type: 'application/zip' }),
				);
				const link = document.createElement('a');
				link.href = url;
				link.download = 'epicenter-demo-account-files.zip';
				link.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				info(`Copied ${archive.length} ZIP bytes from current files`);
			} catch (error) {
				showError(error);
			}
		})();
	element<HTMLInputElement>('import').onchange = () =>
		void (async () => {
			try {
				if (!browserFiles)
					throw new Error('Use unzip into a fresh native folder on desktop');
				const archive = element<HTMLInputElement>('import').files?.[0];
				if (!archive) return;
				await importEmptyAccountFiles(
					browserFiles,
					new Uint8Array(await archive.arrayBuffer()),
				);
				info('Opened ZIP into empty browser files');
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	element('commit').onclick = () =>
		void (async () => {
			try {
				if (desktop) {
					const response = await fetch('/api/desktop-commit', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
					});
					const result = await response.json();
					if (!response.ok) throw new Error(result.error);
					info(result.stdout || 'Committed');
				} else info(`Commit ${await browserGit!.commit()}`);
				await refresh();
			} catch (error) {
				showError(error);
			}
		})();
	for (const direction of ['push', 'pull'] as const) {
		element(direction).onclick = () =>
			void (async () => {
				try {
					if (desktop) {
						const response = await fetch(`/api/desktop-${direction}`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
						});
						const result = await response.json();
						if (!response.ok) throw new Error(result.error);
						info(result.stdout || `${direction} complete`);
					} else {
						const result =
							direction === 'push'
								? await browserGit!.push()
								: await browserGit!.pull();
						info(
							`${direction} complete${typeof result === 'string' ? `: ${result}` : ''}`,
						);
					}
					await refresh();
				} catch (error) {
					showError(error);
				}
			})();
	}
	element('sync-help').textContent = desktop
		? 'Pull after the browser pushes. Commit and push after native edits. Native app writes detect outside changes before replacement, but a Bash write in the final check-to-rename window can still be lost.'
		: `Git and LFS fixture: ${remote}. Commit, push, then pull desktop edits. Commit uploads JPEG bytes to LFS.`;
	files.subscribe(() => {
		void refresh().catch(showError);
	});
	await refresh();
}

void start().catch(showError);
