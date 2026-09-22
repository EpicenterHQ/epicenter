<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fromData } from '@epicenter/svelte';
	import { setPersonal, type PersonalStore } from '../whispering/personal.js';
	let { personal, children }: { personal: PersonalStore; children: Snippet } =
		$props();
	// This provider mounts only after acquisition; descendants capture this exact handle.
	/* svelte-ignore state_referenced_locally */
	setPersonal(fromData(personal));
</script>

{@render children()}
