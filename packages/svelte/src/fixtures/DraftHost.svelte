<script lang="ts">
	import type { Result } from 'wellcrafted/result';
	import { draft } from '../draft.svelte.js';

	type Failure = { message: string };
	let {
		source,
		save,
		expose,
	}: {
		source: () => string;
		save: (value: string) => Promise<Result<unknown, Failure>>;
		expose: (editor: ReturnType<typeof draft<string, Failure>>) => void;
	} = $props();
	// svelte-ignore state_referenced_locally
	const editor = draft(source, save);
	// svelte-ignore state_referenced_locally
	expose(editor);
</script>

<input value={editor.value} oninput={(event) => { editor.value = event.currentTarget.value; }} />
