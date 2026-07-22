<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getHoneycrispApp } from './context.js';

	let { children }: { children: Snippet } = $props();
	const honeycrisp = getHoneycrispApp();
	let identity = $state(honeycrisp.identity);

	$effect(() => {
		identity = honeycrisp.identity;
		return honeycrisp.subscribeIdentity((next) => (identity = next));
	});
</script>

{#if identity.kind === 'ready'}
	{@render children()}
{:else}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="max-w-md space-y-2">
			<h1 class="text-lg font-semibold">These notes belong to another account</h1>
			<p class="text-sm text-muted-foreground">
				This device is attached to principal {identity.attachedPrincipalId}, but
				you are signed in as {identity.signedInPrincipalId}. Sign back into the
				original account or reset this site's local data before continuing.
			</p>
		</div>
	</div>
{/if}
