<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount } from 'svelte';
	import { auth } from '#platform/auth';

	let error = $state('');
	let pending = $state(true);
	let destroyed = false;

	async function signOut() {
		pending = true;
		error = '';
		const result = await auth.signOut();
		if (destroyed) return;
		if (result.error) {
			error = result.error.message;
			pending = false;
			return;
		}
		location.replace(resolve('/'));
	}

	onMount(() => {
		void signOut();
		return () => {
			destroyed = true;
		};
	});
</script>

{#if pending}
	<Loading class="h-dvh" label="Signing out…" />
{:else}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		<p role="alert">Could not sign out: {error}</p>
		<Button onclick={() => void signOut()}>Retry sign out</Button>
	</div>
{/if}
