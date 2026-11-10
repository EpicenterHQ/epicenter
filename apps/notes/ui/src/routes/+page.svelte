<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import NotesShell from '$lib/components/NotesShell.svelte';
</script>

<NotesShell>
	<Empty.Root class="h-full">
		<Empty.Title>Pick a note, or make a new one</Empty.Title>
	</Empty.Root>
</NotesShell>
