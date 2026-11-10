<!-- Wide screens keep the list beside the editor; narrow screens show one at a time. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import NoteList from './NoteList.svelte';

	let { open, children }: { open?: string; children: Snippet } = $props();
</script>

<div
	class="flex h-dvh overflow-hidden bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
>
	<aside
		class="h-dvh w-full shrink-0 overflow-y-auto border-r md:block md:w-80 {open ? 'hidden' : ''}"
	>
		<NoteList {open} />
	</aside>
	<div class="min-w-0 flex-1 overflow-y-auto {open ? '' : 'hidden md:block'}">
		{@render children()}
	</div>
</div>
