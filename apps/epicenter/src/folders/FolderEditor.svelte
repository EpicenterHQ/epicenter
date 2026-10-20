<script lang="ts">
	/**
	 * The files of the folder this window was opened on, inside the
	 * `<FolderApp>` that owns its handle. What is typed is held by the window
	 * (`createFileDrafts`), not by the file shown, and is registered with the
	 * folder context, so hiding the window sends it and closing the window
	 * waits for its saves, and a failed save keeps the window with its text.
	 *
	 * The context refreshes each changed path and its dependents, including
	 * directory descendants and document reads. This editor owns no change listener.
	 */
	import { type getFolder, setFolder } from './context.js';
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import { createFileDrafts } from './drafts.svelte';
	import FolderView from './FolderView.svelte';
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
	const drafts = createFileDrafts({
		files: context.folder.files,
		saved: (path) => context.refresh([path]),
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
</script>

<FolderView {drafts} {updateView} />
