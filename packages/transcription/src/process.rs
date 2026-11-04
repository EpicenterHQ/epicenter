//! Process shutdown for apps that can run native inference.

#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{App, AppHandle, RunEvent, Runtime};

/// Run an app that can run native inference, preserving its ordinary Tauri
/// event callback.
///
/// On macOS, ggml-metal's C++ static finalizers can free the device while Rust
/// still owns a resident model or an inference is running. Once all plugin Exit
/// hooks, the app callback, and Tauri cleanup have run, `_exit` lets the OS reclaim
/// the process without those finalizers. It does not wait for inference.
///
/// The ordering follows Tauri 2.12's `make_run_event_loop_callback`: plugin Exit
/// hooks run before this callback, and `cleanup_before_exit` normally follows it.
/// Keep that ordering when upgrading Tauri. `request_restart` is supported;
/// direct `process::restart` bypasses this shutdown path.
pub fn run<R: Runtime>(app: App<R>, mut callback: impl FnMut(&AppHandle<R>, RunEvent) + 'static) {
    #[cfg(target_os = "macos")]
    let mut exit_code = 0;
    app.run(move |handle, event| {
        #[cfg(target_os = "macos")]
        let exiting = {
            if let RunEvent::ExitRequested { code, .. } = &event {
                exit_code = code.unwrap_or(0);
            }
            matches!(&event, RunEvent::Exit)
        };
        callback(handle, event);
        #[cfg(target_os = "macos")]
        if exiting {
            handle.cleanup_before_exit();
            if exit_code == tauri::RESTART_EXIT_CODE {
                relaunch(&handle.env());
                exit_code = 0;
            }
            log::logger().flush();
            let _ = std::io::Write::flush(&mut std::io::stdout());
            let _ = std::io::Write::flush(&mut std::io::stderr());
            // All Tauri shutdown hooks and cleanup have completed. C++ process
            // finalizers must not race the native work the OS is about to stop.
            unsafe { libc::_exit(exit_code) }
        }
    });
}

#[cfg(target_os = "macos")]
fn relaunch(env: &tauri::Env) {
    let mut binary = match tauri::process::current_binary(env) {
        Ok(binary) => binary,
        Err(error) => {
            log::error!("could not locate the application to restart: {error}");
            return;
        }
    };
    // Match Tauri's macOS restart policy, including an updater that changes the
    // executable name. Its restart helper also calls process::exit, so only the
    // path lookup and spawn can be used here. Failure still logs and exits 0.
    if let Some(macos) = binary
        .parent()
        .filter(|directory| directory.file_name().is_some_and(|name| name == "MacOS"))
    {
        if let Some(contents) = macos
            .parent()
            .filter(|directory| directory.file_name().is_some_and(|name| name == "Contents"))
        {
            if let Ok(info) = plist::from_file::<_, plist::Dictionary>(contents.join("Info.plist"))
            {
                if let Some(name) = info
                    .get("CFBundleExecutable")
                    .and_then(|value| value.as_string())
                {
                    binary = macos.join(name);
                }
            }
        }
    }
    if let Err(error) = std::process::Command::new(binary)
        .args(env.args_os.iter().skip(1))
        .spawn()
    {
        log::error!("failed to restart app: {error}");
    }
}
