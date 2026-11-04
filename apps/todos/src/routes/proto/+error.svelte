<!--
	PROTOTYPE. The error page options (a) and (b) fall to. Two ways to retry
	without a reload: rerun every load, or navigate to the same URL.
-->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
</script>

<main data-testid="error-page">
	<p>error page: {page.status} {page.error?.message}</p>
	<button onclick={() => void invalidateAll()}>Retry invalidateAll</button>
	<button onclick={() => void goto(page.url, { invalidateAll: true })}>Retry goto</button>
	<button onclick={() => location.reload()}>Reload</button>
</main>
