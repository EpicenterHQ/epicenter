<script lang="ts">
		import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();
	const skills = getSkills();

	// The skill's markdown: a nested type on the row, live on the one document
	// this store holds (ADR-0295), so nothing loads and there is no
	// half-hydrated state to bind to. Undefined means the row is gone, which
	// renders as nothing rather than as an empty file it could then save over.
	const content = $derived(
		skills.data.tables.skills.body(skillId),
	);
</script>

{#if content !== undefined}
	{#key skillId}
		<CodeMirrorEditor {content} />
	{/key}
{/if}
