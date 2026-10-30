//! Run Tauri's real updater against an isolated, fully packaged Epicenter.

use std::{path::PathBuf, time::Duration};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_os = "macos") {
        return Err("The packaged update rehearsal runs on macOS only".into());
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [operation, root, current_version, endpoint, public_key] = args.as_slice() else {
        return Err("Expected: check|install ROOT CURRENT_VERSION ENDPOINT PUBLIC_KEY".into());
    };
    if !matches!(operation.as_str(), "check" | "install") {
        return Err("Unknown operation".into());
    }
    let root = PathBuf::from(root).canonicalize()?;
    if !root.starts_with(std::env::temp_dir().canonicalize()?)
        || !root.join("EPICENTER-release-rehearsal").is_file()
    {
        return Err("Only a marked temporary rehearsal directory can be updated".into());
    }
    let endpoint: tauri::Url = endpoint.parse()?;
    if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1") {
        return Err("The rehearsal accepts only its loopback HTTP feed".into());
    }
    let executable =
        root.join("installed/Epicenter Release Rehearsal.app/Contents/MacOS/epicenter");
    if !executable.canonicalize()?.starts_with(&root) {
        return Err("Fixture executable escaped the temporary directory".into());
    }

    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = current_version.parse()?;
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": public_key,
            "dangerousInsecureTransportProtocol": true,
            "requireSignedVersion": true
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])?
        .executable_path(executable)
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()?;

    tauri::async_runtime::block_on(async {
        let Some(update) = updater.check().await? else {
            println!("{}", serde_json::json!({"status": "up-to-date"}));
            return Ok::<_, Box<dyn std::error::Error>>(());
        };
        if operation == "install" {
            let bytes = update.download(|_, _| {}, || {}).await?;
            update.install(bytes)?;
        }
        println!(
            "{}",
            serde_json::json!({
                "status": if operation == "install" { "installed" } else { "available" },
                "version": update.version
            })
        );
        Ok(())
    })
}
