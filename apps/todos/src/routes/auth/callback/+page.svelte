<script lang="ts">
	import { resolve } from '$app/paths';
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '#platform/auth';

	let errorMessage = $state<string | null>(null);

	$effect(() => {
		if (auth === undefined) {
			errorMessage = 'Sign-in is unavailable in this build.';
			return;
		}
		void auth.completeSignIn().then(({ error }) => {
			if (error !== null) {
				errorMessage = error.message;
				return;
			}
			window.location.replace(resolve('/'));
		});
	});
</script>

{#if errorMessage}
	<p role="alert" class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive">
		{errorMessage}
	</p>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
