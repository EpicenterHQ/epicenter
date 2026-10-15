/**
 * The one `epicenter` binary the desktop app ships (ADR-0556): the
 * `epicenter` CLI, plus the Bun host as a hidden `__host` mode until Rust
 * serves the apps. Run with `BUN_BE_BUN=1`, the same binary is `bun`, which
 * installs and builds apps (`src-tauri/src/installed_apps.rs`).
 *
 * The shell starts the host as `epicenter-cli __host --runtime-mode=…`. Each
 * mode loads its code only when chosen, so a CLI command never evaluates the
 * host. No top-level await, so the compiled binary can be bytecode.
 */
import { runCli } from '@epicenter/cli';

/** The hidden argument that selects the Bun host. Never listed in `--help`. */
const HOST_MODE = '__host';

function main() {
	const argv = Bun.argv.slice(2);
	if (argv[0] === HOST_MODE) {
		void import('./main.ts').then(({ runHost }) => runHost());
		return;
	}
	void runCli(argv).then((code) => {
		process.exitCode = code;
	});
}

main();
