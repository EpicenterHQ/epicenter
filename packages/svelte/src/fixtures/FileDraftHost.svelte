<script lang="ts">
	import type { SvelteFolder } from '../folder.js';
	import { fileDraft } from '../folder.js';

	let { folder, path, expose }: {
		folder: SvelteFolder;
		path: string;
		expose: (editor: ReturnType<typeof fileDraft>) => void;
	} = $props();
	// svelte-ignore state_referenced_locally
	const editor = fileDraft(folder, path);
	// svelte-ignore state_referenced_locally
	expose(editor);
</script>

<input value={editor.value} oninput={(event) => { editor.value = event.currentTarget.value; }} />
