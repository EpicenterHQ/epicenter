<!-- Hands what is inside it its own made-up `DictationView`, so the preview can show several states at once. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { type DictationView, setDictation } from '#lib/dictation-view.ts';

	let { view, children }: { view: DictationView; children: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	setDictation(view);
</script>

{@render children()}
