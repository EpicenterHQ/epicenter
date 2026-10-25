<script lang="ts">
	/**
	 * A folder editor window's page, at `/folders/editor/` in the Folders
	 * build. The shell bound one listed folder to this window before it
	 * existed; `<OpenFolder>` opens it with no tables, owns its handle, and
	 * closes it when the window goes. The page names no folder.
	 */
	import { openFolder } from '@epicenter/folder/next/tauri';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import FolderView from './FolderView.svelte';
</script>

<OpenFolder open={() => openFolder({ tables: {} })}>
	{#snippet children(folder)}
		<FolderView {folder} />
	{/snippet}
</OpenFolder>
