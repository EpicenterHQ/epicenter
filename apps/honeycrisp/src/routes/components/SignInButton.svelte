<script lang="ts">
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { Button } from '@epicenter/ui/button';
	const openConnection = getConnectionScreen();
</script>

<Button onclick={openConnection}>Sign in</Button>
