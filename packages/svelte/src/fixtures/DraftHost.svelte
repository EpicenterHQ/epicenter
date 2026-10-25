<script lang="ts">
	import type { Result } from 'wellcrafted/result';
	import { draft } from '../draft.svelte.js';

	type Failure = { message: string };
	let {
		source,
		save,
		delay = 10,
		expose,
	}: {
		source: () => string;
		save: (value: string) => Promise<Result<unknown, Failure>>;
		delay?: number;
		expose: (editor: ReturnType<typeof draft<string, Failure>>) => void;
	} = $props();
	// svelte-ignore state_referenced_locally
	const editor = draft(source, save, { delay });
	// svelte-ignore state_referenced_locally
	expose(editor);
</script>

<input value={editor.value} oninput={(event) => { editor.value = event.currentTarget.value; }} />
