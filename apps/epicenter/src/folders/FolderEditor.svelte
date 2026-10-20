<script lang="ts">
	/**
	 * The files of the folder this window was opened on, inside the
	 * `<FolderApp>` that owns its handle. What is typed is held by the window
	 * (`createFileDrafts`), not by the file shown, and is registered with the
	 * folder context, so hiding the window sends it and closing the window
	 * waits for its saves, and a failed save keeps the window with its text.
	 *
	 * The context marks row reads stale on each change; the generic editor
	 * marks its file and document reads stale too. A directory change
	 * can affect any descendant file. A change that names no path reaches every read
	 * through the context, below whose key these reads sit.
	 */
	import { type getFolder, setFolder } from './context.js';
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { createFileDrafts } from './drafts.svelte';
	import FolderView from './FolderView.svelte';
	import { fileKey } from './files';
	import { updateSavedView } from '@epicenter/folder/tauri';
	import type { ViewUpdater } from './views.svelte';
	let { context, updateView = updateSavedView }: {
		context: ReturnType<typeof getFolder>;
		updateView?: ViewUpdater;
	} = $props();

	// This component owns one opened context for its lifetime.
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
	// svelte-ignore state_referenced_locally
	const root = context.queries.key;
	// svelte-ignore state_referenced_locally
	const drafts = createFileDrafts({
		files: context.folder.files,
		saved: async (path) => {
			await Promise.all([
				context.queryClient.invalidateQueries({ queryKey: fileKey(root, path) }),
				context.queryClient.invalidateQueries({ queryKey: [...root, 'documents'] }),
			]);
		},
	});
	// svelte-ignore state_referenced_locally
	context.registerWork({
		get busy() {
			return drafts.busy;
		},
		get failed() {
			return drafts.failures.length > 0;
		},
		settle: () => drafts.settle(),
	});
	// svelte-ignore state_referenced_locally
	const stop = context.folder.onChange((change) => {
		if (change.paths === null) return;
		void context.queryClient.invalidateQueries({ queryKey: root });
	});
	onDestroy(stop);
</script>

<FolderView {drafts} {updateView} />
