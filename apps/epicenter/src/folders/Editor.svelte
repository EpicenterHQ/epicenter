<script lang="ts">
	/**
	 * A folder editor window's page, at `/folders/editor/` in the Folders
	 * build. The shell bound one listed folder to this window before it
	 * existed; `<FolderApp>` opens it with no tables, owns its handle, and
	 * closes it when the window goes. The page names no folder.
	 */
	import FolderApp from '@epicenter/svelte/folder-app';
	import FolderEditor from './FolderEditor.svelte';

	const tables = {};
</script>

<FolderApp title="Folder" {tables}>
	{#snippet children(context)}
		<FolderEditor {context} />
	{/snippet}
</FolderApp>
