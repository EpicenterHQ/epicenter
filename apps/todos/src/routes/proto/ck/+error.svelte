<!-- PROTOTYPE. A page's render bug under (ck), with SvelteKit's handleRenderingErrors. -->
<script lang="ts">
	import { page } from '$app/state';
</script>

<p data-testid="page-error">page error: {page.error?.message}</p>
