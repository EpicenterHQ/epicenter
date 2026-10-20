<script lang="ts">
	/**
	 * The files of the folder this window was opened on, inside the
	 * `<FolderApp>` that owns its handle. What is typed is held by the folder
	 * itself (`folder.files.edit(path)`), not by the file shown, so hiding the
	 * window sends it, closing the window waits for its saves, and a failed
	 * save keeps the window with its text.
	 *
	 * The context refreshes each changed path and its dependents, including
	 * directory descendants and document reads. This editor owns no change listener.
	 */
	import { type getFolder, setFolder } from './context.js';
	import { setQueryClientContext } from '@tanstack/svelte-query';
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
</script>

<FolderView {updateView} />
