<!--
	The sign-in callback, outside the app's group: it reads no files. The
	build's `Callback` (`#platform/components`) finishes a web sign-in; the desktop
	window never signs in here.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Callback } from '#platform/components';
</script>

<Callback home={resolve('/')} />
