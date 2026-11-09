<!--
	The sign-in callback, outside the app's group: it reads no files.
	`SignInCallback` finishes a browser's sign-in; a Tauri window never signs
	in here.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import SignInCallback from '$lib/components/SignInCallback.svelte';
</script>

<SignInCallback home={resolve('/')} />
