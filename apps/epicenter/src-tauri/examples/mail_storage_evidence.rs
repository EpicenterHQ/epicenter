//! Isolated Local Mail evidence over the production native SQLite worker.
#![allow(dead_code)]

#[path = "../src/device_owner.rs"]
mod device_owner;
#[path = "../src/sqlite.rs"]
mod sqlite;

use std::{
    io::{self, BufRead},
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::Duration,
};

fn main() {
    let root = std::env::args().nth(1).expect("isolated data directory");
    let (sender, responses) = mpsc::sync_channel(64);
    let mut worker = sqlite::Worker::new(root.into(), 1, sender, Arc::new(AtomicBool::new(false)));
    for line in io::stdin().lock().lines() {
        let frame: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        assert_eq!(frame["type"], "sqlite");
        worker
            .submit(
                frame["requestId"].as_str().unwrap().into(),
                serde_json::from_value(frame["request"].clone()).unwrap(),
            )
            .unwrap();
        println!("{}", responses.recv_timeout(Duration::from_secs(10)).unwrap());
    }
    worker.stop();
}
