use serde::{Deserialize, Serialize};

/// Cumulative download progress for one model: bytes received so far across all
/// of its files, and the grand total to expect. The frontend turns it into a
/// 0-100 percent.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    /// Bytes received so far. `f64` because specta forbids exporting 64-bit
    /// ints to TypeScript; model sizes are far below `f64`'s 2^53 exact-integer
    /// ceiling, so no precision is lost.
    bytes_received: f64,
    /// Grand total bytes for the whole model (sum of the catalog file sizes).
    total_bytes: f64,
}

impl DownloadProgress {
    pub(crate) fn new(bytes_received: f64, total_bytes: f64) -> Self {
        Self {
            bytes_received,
            total_bytes,
        }
    }
}

use crate::CatalogError;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

/// A reservation belongs to the blocking closure, never to the IPC waiter.
#[derive(Default, Clone)]
pub struct Downloads(Arc<Mutex<HashSet<String>>>);

struct Reservation {
    downloads: Downloads,
    id: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.downloads
            .0
            .lock()
            .expect("download reservations poisoned")
            .remove(&self.id);
    }
}

impl Downloads {
    /// Reserve before queueing; dropping even an unstarted closure releases it.
    pub(crate) fn worker<T>(
        &self,
        id: String,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<impl FnOnce() -> T + Send + 'static, CatalogError> {
        if !self
            .0
            .lock()
            .expect("download reservations poisoned")
            .insert(id.clone())
        {
            return Err(CatalogError::Busy {
                message: "This model is already downloading.".into(),
            });
        }
        let reservation = Reservation {
            downloads: self.clone(),
            id,
        };
        Ok(move || {
            let _reservation = reservation;
            work()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_clears_after_success_error_and_unstarted_drop() {
        let downloads = Downloads::default();
        let work = downloads
            .worker("model".into(), || Ok::<_, ()>(()))
            .unwrap();
        assert!(matches!(
            downloads.worker("model".into(), || ()),
            Err(CatalogError::Busy { .. })
        ));
        assert_eq!(work(), Ok(()));
        assert_eq!(
            downloads
                .worker("model".into(), || Err::<(), _>("failed"))
                .unwrap()(),
            Err("failed")
        );
        drop(downloads.worker("model".into(), || ()).unwrap());
        assert!(downloads.worker("model".into(), || ()).is_ok());
    }

    #[test]
    fn dropping_waiter_retains_reservation_until_worker_finishes() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let downloads = Downloads::default();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
            let worker = downloads
                .worker("model".into(), move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                })
                .unwrap();
            let handle = tauri::async_runtime::spawn_blocking(move || {
                worker();
                finished_tx.send(()).unwrap();
            });
            started_rx.await.unwrap();
            let waiter = async move { handle.await };
            drop(waiter);
            assert!(matches!(
                downloads.worker("model".into(), || ()),
                Err(CatalogError::Busy { .. })
            ));
            release_tx.send(()).unwrap();
            finished_rx.await.unwrap();
            assert!(downloads.worker("model".into(), || ()).is_ok());
        });
    }
}
