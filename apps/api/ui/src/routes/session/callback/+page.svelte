<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import { authClient } from '$lib/platform/auth';

	const completion = authClient.completeSignIn().then((result) => {
		if (result.error) throw new Error(result.error.message);
		window.location.replace('/dashboard');
	});
</script>

<svelte:head>
	<title>Signing in: Epicenter</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="flex min-h-screen items-center justify-center p-6">
	{#await completion}
		<Spinner class="size-5" />
	{:then _}
		<p>Opening dashboard…</p>
	{:catch error}
		<div class="space-y-3 text-center">
			<p role="alert">{error.message}</p>
			<a href="/dashboard" class="underline">Return to dashboard</a>
		</div>
	{/await}
</div>
