//! The app in front when the global shortcut is pressed: the app the person
//! is dictating into, which cleanup tells the model about. macOS answers
//! this without asking the person for any permission; reading a window's
//! title or text would need one, and this reads neither.

use serde::Serialize;

/// An app, by its bundle id and the name a person sees.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontApp {
    pub bundle_id: String,
    pub name: String,
}

/// The app in front now, or None when it is Whispering itself (the person
/// clicked Record in its window, so no other app is named), has no bundle
/// id, or the system cannot say.
#[cfg(target_os = "macos")]
pub fn front_app() -> Option<FrontApp> {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};

    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let own = NSRunningApplication::currentApplication();
    if app.processIdentifier() == own.processIdentifier() {
        return None;
    }
    let bundle_id = app.bundleIdentifier()?.to_string();
    let name = app
        .localizedName()
        .map(|name| name.to_string())
        .unwrap_or_else(|| bundle_id.clone());
    Some(FrontApp { bundle_id, name })
}

/// Other systems are not asked yet.
#[cfg(not(target_os = "macos"))]
pub fn front_app() -> Option<FrontApp> {
    None
}
