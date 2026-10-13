<script lang="ts">
	import { resolve } from '$app/paths';
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '#platform/auth';

	let errorMessage = $state<string | null>(null);

	$effect(() => {
		let alive = true;
		if (auth === undefined) {
			errorMessage = 'Sign-in is unavailable in this build.';
			return () => { alive = false; };
		}
		void auth.completeSignIn().then(({ error }) => {
			if (!alive) return;
			if (error !== null) {
				errorMessage = error.message;
				return;
			}
			window.location.replace(resolve('/'));
		}).catch(() => {
			if (alive) errorMessage = 'Sign-in could not finish. Try again.';
		});
		return () => { alive = false; };
	});
</script>

{#if errorMessage}
	<p role="alert" class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive">
		{errorMessage}
	</p>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
