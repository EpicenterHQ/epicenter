<!--
	One task's page, at the task's path: `#/tasks/<time>.md`. Keyed by the
	path so each task gets its own editor.
-->
<script lang="ts">
	import { page } from '$app/state';
	import TaskEditor from '$lib/components/TaskEditor.svelte';
</script>

{#key page.params.path}
	<TaskEditor path={page.params.path ?? ''} />
{/key}
