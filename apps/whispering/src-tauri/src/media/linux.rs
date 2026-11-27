//! Linux playback control via MPRIS over the session D-Bus, hand-rolled on zbus
//! (pure Rust, no libdbus build dep). Covers any MPRIS player, including
//! Chromium/Firefox (native MPRIS since v81).
//!
//! The session token is the player's well-known bus name
//! (`org.mpris.MediaPlayer2.<player>`; browsers and multi-instance players carry
//! an `.instance_<n>` suffix, which we keep verbatim so resume re-resolves the
//! exact instance). `pause_playing` pauses every player reporting
//! `PlaybackStatus == "Playing"` and remembers its bus name; `resume`
//! re-resolves those names against the live list and plays the ones still there.
//!
//! No session bus (headless/SSH) -> `Connection::session()` errors -> no-op. A
//! 2s cap keeps a stalled player from wedging the serialized pause/resume chain.

use std::time::Duration;

use zbus::fdo::DBusProxy;
use zbus::{Connection, Proxy};

const MPRIS_PREFIX: &str = "org.mpris.MediaPlayer2.";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const DBUS_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn pause_playing() -> Result<Vec<String>, String> {
    let paused = match tokio::time::timeout(DBUS_TIMEOUT, pause_playing_inner()).await {
        Ok(Ok(paused)) => paused,
        Ok(Err(e)) => {
            // No session bus, no players, etc. Expected; degrade to no-op.
            log::debug!("MPRIS pause unavailable: {e}");
            Vec::new()
        }
        Err(_) => {
            log::warn!("MPRIS pause timed out");
            Vec::new()
        }
    };
    Ok(paused)
}

pub async fn resume(sessions: Vec<String>) -> Result<(), String> {
    if sessions.is_empty() {
        return Ok(());
    }
    match tokio::time::timeout(DBUS_TIMEOUT, resume_inner(sessions)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::debug!("MPRIS resume unavailable: {e}"),
        Err(_) => log::warn!("MPRIS resume timed out"),
    }
    Ok(())
}

async fn pause_playing_inner() -> zbus::Result<Vec<String>> {
    let connection = Connection::session().await?;
    let mut paused = Vec::new();
    for name in mpris_players(&connection).await? {
        match pause_if_playing(&connection, &name).await {
            Ok(true) => paused.push(name),
            Ok(false) => {}
            Err(e) => log::warn!("MPRIS pause failed for {name}: {e}"),
        }
    }
    Ok(paused)
}

async fn resume_inner(sessions: Vec<String>) -> zbus::Result<()> {
    let connection = Connection::session().await?;
    let live = mpris_players(&connection).await?;
    for name in sessions {
        // Safety rule: only play a session we personally paused and that is
        // still present (re-resolve by exact bus name, tolerate absence).
        if !live.contains(&name) {
            continue;
        }
        let player = player_proxy(&connection, &name).await?;
        if let Err(e) = player.call::<_, _, ()>("Play", &()).await {
            log::warn!("MPRIS play failed for {name}: {e}");
        }
    }
    Ok(())
}

async fn mpris_players(connection: &Connection) -> zbus::Result<Vec<String>> {
    let dbus = DBusProxy::new(connection).await?;
    let names = dbus.list_names().await?;
    Ok(names
        .into_iter()
        .map(|name| name.as_str().to_owned())
        .filter(|name| name.starts_with(MPRIS_PREFIX))
        .collect())
}

async fn pause_if_playing(connection: &Connection, name: &str) -> zbus::Result<bool> {
    let player = player_proxy(connection, name).await?;
    // Respect CanPause; a player that declines pause is skipped, not an error.
    if !player
        .get_property::<bool>("CanPause")
        .await
        .unwrap_or(false)
    {
        return Ok(false);
    }
    let status: String = player.get_property("PlaybackStatus").await?;
    if status != "Playing" {
        return Ok(false);
    }
    // Dedicated Pause(), never the PlayPause() toggle, so we never start playback.
    player.call::<_, _, ()>("Pause", &()).await?;
    Ok(true)
}

async fn player_proxy(connection: &Connection, name: &str) -> zbus::Result<Proxy<'static>> {
    Proxy::new(connection, name.to_owned(), MPRIS_PATH, PLAYER_IFACE).await
}
