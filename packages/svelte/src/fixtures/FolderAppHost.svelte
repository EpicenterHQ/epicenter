<!-- `<FolderApp>` over `tables`, handing its opened context to the test. -->
<script lang="ts">
	import type { TSchema } from 'typebox';
	import FolderApp from '../folder-app.svelte';
	import type { FolderContext } from '../folder-context.js';
	import ContextProbe from './ContextProbe.svelte';

	let {
		tables,
		saveAfterMs,
		onContext,
	}: {
		tables: Record<string, TSchema>;
		saveAfterMs?: number;
		onContext: (context: FolderContext) => void;
	} = $props();
</script>

<FolderApp title="Notes" {tables} {saveAfterMs}><ContextProbe {onContext} /></FolderApp>
