<script lang="ts">
		import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();
	const skills = getSkills();

	// Same shape as InstructionsEditor: the content is a nested type on the row
	// (ADR-0295), so there is nothing to open and nothing to dispose.
	const content = $derived(
		skills.data.tables.skillReferences.body(id),
	);
</script>

<div class="h-48 border-t">
	{#if content !== undefined}
		{#key id}
			<CodeMirrorEditor {content} />
		{/key}
	{/if}
</div>
