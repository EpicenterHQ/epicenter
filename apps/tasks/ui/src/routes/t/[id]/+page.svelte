<!--
	One task's page, keyed by its id so each task gets its own editor.
-->
<script lang="ts">
	import { page } from '$app/state';
	import TaskEditor from '$lib/components/TaskEditor.svelte';
</script>

{#key page.params.id}
	<TaskEditor id={page.params.id ?? ''} />
{/key}
