<script lang="ts">
	import type { SvelteFolder } from '../folder.js';
	import { fileEdit } from '../folder.js';

	let { folder, path, expose }: {
		folder: SvelteFolder;
		path: string;
		expose: (editor: ReturnType<typeof fileEdit>) => void;
	} = $props();
	// svelte-ignore state_referenced_locally
	const editor = fileEdit(folder, path);
	// svelte-ignore state_referenced_locally
	expose(editor);
</script>

<input value={editor.value} oninput={(event) => { editor.value = event.currentTarget.value; }} />
