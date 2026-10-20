//! Native tabs group independent folder windows. AppKit owns membership and
//! selection; each page still owns its saves and its window's close.

use anyhow::Context;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindow};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Runtime, WebviewWindow, WebviewWindowBuilder};

const FOLDER_TABS: &str = "so.epicenter.folder-windows";
const MERGE: &str = "merge-folder-windows";
const DETACH: &str = "detach-folder-tab";
const CLOSE_GROUP: &str = "close-folder-tab-group";

pub(crate) fn build<R: Runtime>(
    builder: WebviewWindowBuilder<'_, R, AppHandle<R>>,
) -> anyhow::Result<WebviewWindow<R>> {
    let main =
        MainThreadMarker::new().context("folder windows must be built on the main thread")?;
    // Tauri turns this process-wide setting off when any window has no
    // tabbing identifier, including the optional dictation overlay. Restore it
    // before showing a folder window, while
    // leaving Automatic mode to honor the person's macOS tab preference.
    NSWindow::setAllowsAutomaticWindowTabbing(true, main);
    Ok(builder.tabbing_identifier(FOLDER_TABS).build()?)
}

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    let window = menu
        .get(WINDOW_SUBMENU_ID)
        .context("default Window menu is missing")?;
    let submenu = window
        .as_submenu()
        .context("default Window menu is not a submenu")?;
    submenu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, MERGE, "Merge Folder Windows", true, None::<&str>)?,
        &MenuItem::with_id(app, DETACH, "Move Tab to New Window", true, None::<&str>)?,
        &MenuItem::with_id(
            app,
            CLOSE_GROUP,
            "Close Tab Group",
            true,
            Some("Cmd+Shift+W"),
        )?,
    ])?;
    app.set_menu(menu)?;
    app.on_menu_event(|_, event| {
        let Some(main) = MainThreadMarker::new() else {
            return;
        };
        let Some(window) = NSApplication::sharedApplication(main).keyWindow() else {
            return;
        };
        if window.tabbingIdentifier().to_string() != FOLDER_TABS {
            return;
        }
        match event.id().as_ref() {
            MERGE => window.mergeAllWindows(None),
            DETACH => window.moveTabToNewWindow(None),
            CLOSE_GROUP => close_group(&window),
            _ => {}
        }
    });
    Ok(())
}

/// Ask each original member to close. A page with unfinished input stays
/// alive; peers that save may close. Never use NSWindow::close or destroy
/// here: both bypass the page's close guard.
pub(crate) fn close_group(window: &NSWindow) {
    if let Some(group) = window.tabGroup() {
        // AppKit returns a retained snapshot. Membership can change as pages
        // answer asynchronously, so do not read the live group in this loop.
        let windows = group.windows();
        for member in windows.iter() {
            member.performClose(None);
        }
    } else {
        window.performClose(None);
    }
}
