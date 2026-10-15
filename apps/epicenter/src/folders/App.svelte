<script lang="ts">
	/**
	 * A placeholder while the Folders window's view is built. The host already
	 * lists the data folders for this window (`list_data_folders`) and permits
	 * it into each one, so the view opens a folder with
	 * `openDataFolder({ id })` from `@epicenter/folder/tauri`.
	 */
</script>

<main class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
	<h1 class="text-2xl font-semibold">Folders</h1>
	<p class="text-muted-foreground">
		Every data folder in your Epicenter folder will open here.
	</p>
</main>
