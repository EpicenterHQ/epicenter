<script lang="ts">
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { authStartup } from '#platform/auth';
	import { resolve } from '$app/paths';

	// The callback completes identity and replaces the document. It opens no App.
	let errorMessage = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			const auth = authStartup.auth;
			if (!auth || !isCallbackAuthClient(auth)) {
				// The desktop build signs in through the host, which relaunches the
				// process, so no browser callback lands here.
				errorMessage =
					'This build does not sign in through a browser callback.';
				return;
			}
			const { error } = await auth.completeSignIn();
			if (error) {
				errorMessage = error.message;
				return;
			}
			window.location.replace(resolve('/'));
		})();
	});
</script>

{#if errorMessage}
	<div
		class="flex h-dvh items-center justify-center px-6 text-center text-sm text-destructive"
	>
		{errorMessage}
	</div>
{:else}
	<Loading class="h-dvh" label="Signing in…" />
{/if}
