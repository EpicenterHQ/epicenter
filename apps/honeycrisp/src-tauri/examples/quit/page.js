// The fixture page of `examples/quit`: a page-like voter, not the notes page.
// The harness evaluates this in the notes window once the page loaded; it
// runs with that window's real IPC, capability, and folder scope.
//
// It keeps the production page's order (`src/lib/platform/shell.tauri.ts`):
// register, listen for close requests, take the folder's grant, then say the
// folder is open. It answers the first close request with "keep editing" and
// every later one with an approval. Unlike the notes page, it approves
// without settling its writes first, so writes it started are still running
// when the shell exits: the harness checks that each file they leave is
// whole.
//
// It writes the way the folder engine does (`directory-handle.ts` in
// `packages/folder`): the bytes go to a new file under
// `.git/epicenter/scratch` through the folder plugin's `write_folder_file`,
// which is then renamed over the path. It reports through the folder itself
// under
// `harness/`, because the window's capability lets it emit nothing else.
// `__SCOPE__` is filled in by the harness.
(async () => {
	const internals = window.__TAURI_INTERNALS__;
	const invoke = (command, args) => internals.invoke(command, args);
	const bytes = (text) => Array.from(new TextEncoder().encode(text));
	const scope = '__SCOPE__';
	let root;
	const mkdir = (path) =>
		invoke('plugin:epicenter-folder|make_folder_directory', {
			scope,
			path: `${root}/${path}`,
		});
	let staged = 0;
	const write = async (path, text) => {
		const copy = `${root}/.git/epicenter/scratch/fixture-${staged++}`;
		await invoke('plugin:epicenter-folder|write_folder_file', {
			scope,
			path: copy,
			bytes: bytes(text),
			createNew: true,
		});
		await invoke('plugin:epicenter-folder|rename_folder_path', {
			scope,
			from: copy,
			to: `${root}/${path}`,
		});
	};
	const report = (name, value) =>
		write(`harness/${name}.json`, JSON.stringify(value));

	const generation = await invoke('close_register');
	const answered = new Set();
	const handler = internals.transformCallback(async ({ payload }) => {
		// The shell repeats an unanswered request; each is answered once.
		if (payload.generation !== generation || answered.has(payload.request))
			return;
		answered.add(payload.request);
		const ask = { generation, request: payload.request };
		if (answered.size === 1) {
			await invoke('close_decline', ask);
			await report('declined', ask);
		} else {
			await invoke('close_approve', ask);
		}
	});
	await invoke('plugin:event|listen', {
		event: 'close-requested',
		target: { kind: 'Any' },
		handler,
	});
	const granted = await invoke('plugin:epicenter-folder|grant_directory', {
		scope,
	});
	root = granted.root;
	await mkdir('.git/epicenter/scratch');
	await mkdir('harness');
	await mkdir('batch');
	await invoke('close_opened', { generation });

	window.__quitFixture = {
		// `count` new files, each its own write, all sent at once and none
		// awaited. The shell admits each as it arrives and writes them on its
		// blocking pool.
		startBatch(count) {
			for (let index = 0; index < count; index += 1)
				write(
					`batch/${String(index).padStart(6, '0')}.md`,
					`${index}\n`,
				).catch(() => {});
		},
	};
	await report('ready', { generation, root });
})();
