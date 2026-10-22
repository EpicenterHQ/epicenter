<script lang="ts">
	/**
	 * The files of the folder this window was opened on, inside the
	 * `<FolderApp>` that owns its handle. What is typed is held by the folder
	 * itself (`folder.files.edit(path)`), not by the file shown. Hiding the
	 * window sends it. Pending saves prompt before departure; confirming
	 * closes immediately and may discard unsaved input.
	 *
	 * The context refreshes each changed path and its dependents, including
	 * directory descendants and document reads. This editor owns no change listener.
	 */
	import { type getFolder, setFolder } from './context.js';
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import FolderView from './FolderView.svelte';
	let { context }: {
		context: ReturnType<typeof getFolder>;
	} = $props();

	// This component owns one opened context for its lifetime.
	// svelte-ignore state_referenced_locally
	const { queryClient } = setFolder(context);
	setQueryClientContext(queryClient);
</script>

<FolderView />
