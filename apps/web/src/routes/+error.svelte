<!--
	An address the shell has no page for: an owner, repository or app
	segment that is not a name (ADR-0693), or an app segment that is not a
	hostname.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { page } from '$app/state';
</script>

<svelte:head><title>Not found · Epicenter</title></svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-4 p-6" aria-label="Not found">
	<h1 class="text-lg font-semibold">Nothing is at <code>{page.url.pathname}</code></h1>
	<p class="text-sm text-muted-foreground">
		An address is an owner, a repository, or an app on one: <code>/&lt;owner&gt;/&lt;repo&gt;/&lt;hostname&gt;/…</code>, where an app is named by the hostname it is served at.
	</p>
	<p><Button size="sm" variant="outline" href="/me">You</Button></p>
</main>
