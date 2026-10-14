// The fixture page of `examples/quit`: a page-like voter, not Whispering's
// page. The real Bun host serves it in place of the built page, so it runs in
// the main window on the host's origin, with that window's real Tauri IPC and
// capability and the bridge credential the shell gives the host's page.
//
// It hears the shell's close question the way `src/lib/workspace/closing.ts`
// does, on the host's event stream, and answers it the way the desktop
// workspace does, with `POST /bridge/app { op: "close" }`. With the host gone
// it hears the shell's `whispering:close-blocked` event and quits through the
// quit address, as `quitWithoutHost` does.
//
// It opens the folder as the page's engine does: `grant_directory`, then
// `git init` through `run_git`. Every file it writes is written the way the
// engine writes one (`directory-handle.ts` in `packages/folder`): the bytes go
// to a new file under `.git/epicenter/scratch`, which is then renamed over the
// path. Those are two commands, so a quit between them leaves the staged copy
// behind and the path as it was.
//
// It answers the first question with `cancel` ("Keep working") and the next
// with `proceed`. In `approve` it first waits until its batch has settled, as
// Whispering's page does (`prepareToLeave`); in `early` it approves at once,
// with the batch still being written.
//
// It reports through the folder itself, under `harness/`. `__SCOPE__` and
// `__SCENARIO__` are filled in by the harness.
(async () => {
	const internals = window.__TAURI_INTERNALS__;
	const invoke = (command, args) =>
		internals.invoke(`plugin:epicenter-folder|${command}`, args);
	const origin = window.location.origin;
	const authorization = `Bearer ${window.__WHISPERING_BRIDGE__.token}`;
	const scope = '__SCOPE__';
	const scenario = '__SCENARIO__';
	const bytes = (text) => Array.from(new TextEncoder().encode(text));

	const granted = await invoke('grant_directory', { scope });
	const root = granted.root;
	const scratch = `${root}/.git/epicenter/scratch`;
	let staged = 0;
	await invoke('run_git', {
		scope,
		args: ['init', '--quiet', `--initial-branch=${granted.branch}`],
		input: null,
		indexFile: null,
		authorization: null,
		request: crypto.randomUUID(),
	});
	for (const directory of [scratch, `${root}/harness`, `${root}/batch`])
		await invoke('make_folder_directory', { scope, path: directory });

	// One file, as the engine writes it: staged, then renamed into place.
	const write = async (path, text) => {
		const copy = `${scratch}/fixture-${staged++}`;
		await invoke('write_folder_file', {
			scope,
			path: copy,
			bytes: bytes(text),
			createNew: true,
		});
		await invoke('rename_folder_path', {
			scope,
			from: copy,
			to: `${root}/${path}`,
		});
	};
	const report = (name, value) =>
		write(`harness/${name}.json`, JSON.stringify(value));

	const answer = async (decision) => {
		const response = await fetch(`${origin}/bridge/app`, {
			method: 'POST',
			headers: { authorization, 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'close', payload: { decision } }),
		});
		if (!response.ok) throw new Error(`close ${decision}: ${response.status}`);
	};

	/** The batch being written, once one was started. */
	let batch;
	let asked = 0;
	const closeRequested = async () => {
		asked += 1;
		if (asked === 1) {
			await answer('cancel');
			await report('declined', { asked });
			return;
		}
		if (scenario === 'approve') await batch?.catch(() => {});
		await answer('proceed');
	};

	let blocked = 0;
	window.addEventListener('whispering:close-blocked', () => {
		blocked += 1;
		if (blocked === 1) void report('blocked', { blocked });
		else window.location.assign(`${origin}/__whispering__/quit`);
	});

	// The host's event stream: one JSON line per event. The host repeats a
	// question nobody has answered to every stream that connects, so one asked
	// before this connects is not lost.
	void (async () => {
		const decoder = new TextDecoder();
		let pending = '';
		try {
			const events = await fetch(`${origin}/bridge/events`, {
				headers: { authorization },
			});
			if (!events.ok) throw new Error(`events: ${events.status}`);
			const reader = events.body.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				pending += decoder.decode(value, { stream: true });
				let newline = pending.indexOf('\n');
				while (newline >= 0) {
					const line = pending.slice(0, newline).trim();
					pending = pending.slice(newline + 1);
					if (line !== '' && JSON.parse(line).type === 'close-requested')
						void closeRequested();
					newline = pending.indexOf('\n');
				}
			}
		} catch {
			// The host is gone; the shell's page event is the question now.
		}
	})();

	window.__quitFixture = {
		// `count` new files, one after another, as a page's saves are: started
		// here and not awaited.
		startBatch(count) {
			batch = (async () => {
				for (let index = 0; index < count; index += 1)
					await write(
						`batch/${String(index).padStart(6, '0')}.md`,
						`${index}\n`,
					);
			})();
			batch.catch(() => {});
		},
	};
	await report('ready', {
		scenario,
		root,
		port: Number(window.location.port),
	});
})();
