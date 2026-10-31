<!--
	The end of sign-in, the variant's (`#platform/root`): the web app finishes
	it and loads the page it started from; the desktop window signs in
	through the system browser and never comes here.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Callback } from '#platform/root';
</script>

<Callback home={resolve('/')} />
