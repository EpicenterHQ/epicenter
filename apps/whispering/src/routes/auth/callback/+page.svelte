<!--
	The sign-in callback, outside the app's group: it opens no files. The
	build's `Callback` (`#platform/root`) finishes a web sign-in; the desktop
	window never signs in here.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Callback } from '#platform/root';
</script>

<Callback home={resolve('/')} />
