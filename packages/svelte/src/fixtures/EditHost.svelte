<script lang="ts">
	import type { Result } from 'wellcrafted/result';
	import { edit } from '../edit.svelte.js';

	type Failure = { message: string };
	let {
		source,
		save,
		expose,
	}: {
		source: () => string;
		save: (value: string, base: string) => Promise<Result<unknown, Failure>>;
		expose: (editor: ReturnType<typeof edit<string, Failure>>) => void;
	} = $props();
	// svelte-ignore state_referenced_locally
	const editor = edit(source, save);
	// svelte-ignore state_referenced_locally
	expose(editor);
</script>

<input value={editor.value} oninput={(event) => { editor.value = event.currentTarget.value; }} />
