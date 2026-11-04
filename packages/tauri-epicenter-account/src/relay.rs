//! How a request the page asked for comes back to it: on a channel, its head,
//! then its body's raw chunks as they arrive, then its end or an error. Both
//! of this crate's relays answer this way (`account_fetch`, and
//! `connection_fetch` in `connection.rs`), and the page reads them with one
//! reader (`@epicenter/account/tauri`). A relay's requests in flight are kept by
//! the id the page gave each, so the page can stop one.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

/// What a relay sends the page besides the body's raw chunks. `E` is the
/// relay's own error, flattened beside `kind`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RelayEvent<E> {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
    },
    End,
    Error(E),
}

pub(crate) fn send_event<E: Serialize>(
    channel: &Channel<InvokeResponseBody>,
    event: &RelayEvent<E>,
) {
    let _ = channel.send(InvokeResponseBody::Json(
        serde_json::to_string(event).expect("an event serializes"),
    ));
}

/// Send `response` to the page: its head, each chunk of its body as it
/// arrives, then its end, or `failed(message)` when the body breaks off.
/// A refusal (any status but a success) of a request sent with `key` is read
/// whole first and sent with the key removed wherever it repeats it.
pub(crate) async fn answer<E: Serialize>(
    response: reqwest::Response,
    channel: &Channel<InvokeResponseBody>,
    failed: impl Fn(String) -> E,
    key: Option<&str>,
) {
    let redact = key.filter(|_| !response.status().is_success());
    let headers = response
        .headers()
        .iter()
        // A body with the key removed has another length.
        .filter(|(name, _)| redact.is_none() || *name != reqwest::header::CONTENT_LENGTH)
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    send_event::<E>(
        channel,
        &RelayEvent::Head {
            status: response.status().as_u16(),
            headers,
        },
    );
    if let Some(key) = redact {
        match response.bytes().await {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).replace(key, "[key removed]");
                let _ = channel.send(InvokeResponseBody::Raw(text.into_bytes()));
                send_event::<E>(channel, &RelayEvent::End);
            }
            Err(cause) => send_event(channel, &RelayEvent::Error(failed(cause.to_string()))),
        }
        return;
    }
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if channel
                    .send(InvokeResponseBody::Raw(bytes.to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            Err(cause) => {
                return send_event(channel, &RelayEvent::Error(failed(cause.to_string())))
            }
        }
    }
    send_event::<E>(channel, &RelayEvent::End);
}

/// A relay's requests in flight, by the id the page gave each.
#[derive(Clone, Default)]
pub(crate) struct Requests(Arc<Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>>);

impl Requests {
    /// Run `work` as the request `id`, stopping an earlier one with that id.
    pub(crate) fn start(&self, id: u32, work: impl Future<Output = ()> + Send + 'static) {
        // Held while spawning, so the task's own removal comes after this insert.
        let mut requests = self.0.lock().unwrap();
        let finished = self.clone();
        let task = tauri::async_runtime::spawn(async move {
            work.await;
            finished.0.lock().unwrap().remove(&id);
        });
        if let Some(previous) = requests.insert(id, task) {
            previous.abort();
        }
    }

    /// Stop the request `id`, if it is still in flight.
    pub(crate) fn cancel(&self, id: u32) {
        if let Some(task) = self.0.lock().unwrap().remove(&id) {
            task.abort();
        }
    }
}
