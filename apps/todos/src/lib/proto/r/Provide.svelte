<!--
	PROTOTYPE, standing for a shared `@epicenter/svelte/provide`: sets a
	context to a value during its own setup, which a layout cannot do after
	an `await` (`set_context_after_init`).
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';

	let { value, set, children }: { value: T; set: (value: T) => void; children: Snippet } =
		$props();
	// svelte-ignore state_referenced_locally
	set(value);
</script>

{@render children()}
