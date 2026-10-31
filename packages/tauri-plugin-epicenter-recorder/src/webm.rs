//! The container a stopped recording is kept in: Opus in WebM, laid out as
//! the Matroska Opus mapping says and as `ffmpeg` writes it, which Safari
//! and Chromium both play and decode to the exact length.
//!
//! - an EBML header (`webm`, version 4, for `DiscardPadding`);
//! - one Segment, its size written last;
//! - a SeekHead naming Info, Tracks, and Cues;
//! - Info: millisecond ticks, and the Duration that plays, written last;
//! - one `A_OPUS` track: `OpusHead` as its CodecPrivate, the pre-skip again
//!   as CodecDelay, and 80 ms of SeekPreRoll;
//! - Clusters of SimpleBlocks, one packet each, a new Cluster every 5 s;
//! - the last packet in a BlockGroup whose DiscardPadding trims what the
//!   encoder padded the end with;
//! - Cues: one per Cluster.
//!
//! A block's time is where its packet starts in the encoded stream, pre-skip
//! included; a player subtracts CodecDelay. Nothing here varies between two
//! writes of the same packets: no date, no random SegmentUID (the element is
//! optional and left out) or TrackUID. Recovery tells a recording it already
//! placed by its bytes (`staging::sweep`), so the same WAV must encode to the
//! same file.
//!
//! Each Cluster is held in memory until it is whole (5 s of packets, a few
//! kilobytes), then written with its size; only the Segment's size, the
//! Duration, and the Cues' position are written back at the end.

use std::io::{self, Seek, SeekFrom, Write};

/// libopus decodes at 48 kHz; Matroska's Opus times and paddings count at it.
pub const OPUS_RATE: u64 = 48_000;
/// Every packet holds 20 ms.
pub const FRAME_48K: u64 = 960;
/// Packets per Cluster: 5 s, well inside a block's signed 16-bit time.
const CLUSTER_BLOCKS: u64 = 250;
/// Nanoseconds per Info tick: one millisecond.
const TICK_NS: u64 = 1_000_000;
/// What Matroska's Opus mapping asks a player to decode before a point it
/// seeks to.
const SEEK_PRE_ROLL_NS: u64 = 80_000_000;
const WRITING_APP: &str = "Epicenter recorder";

const EBML: u32 = 0x1A45_DFA3;
const EBML_VERSION: u32 = 0x4286;
const EBML_READ_VERSION: u32 = 0x42F7;
const EBML_MAX_ID_LENGTH: u32 = 0x42F2;
const EBML_MAX_SIZE_LENGTH: u32 = 0x42F3;
const DOC_TYPE: u32 = 0x4282;
const DOC_TYPE_VERSION: u32 = 0x4287;
const DOC_TYPE_READ_VERSION: u32 = 0x4285;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const SEEK: u32 = 0x4DBB;
const SEEK_ID: u32 = 0x53AB;
const SEEK_POSITION: u32 = 0x53AC;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const MUXING_APP: u32 = 0x4D80;
const WRITING_APP_ID: u32 = 0x5741;
const DURATION: u32 = 0x4489;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_UID: u32 = 0x73C5;
const TRACK_TYPE: u32 = 0x83;
const FLAG_LACING: u32 = 0x9C;
const CODEC_ID: u32 = 0x86;
const CODEC_PRIVATE: u32 = 0x63A2;
const CODEC_DELAY: u32 = 0x56AA;
const SEEK_PRE_ROLL: u32 = 0x56BB;
const AUDIO: u32 = 0xE1;
const SAMPLING_FREQUENCY: u32 = 0xB5;
const CHANNELS: u32 = 0x9F;
const CLUSTER: u32 = 0x1F43_B675;
const TIMESTAMP: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;
const DISCARD_PADDING: u32 = 0x75A2;
const CUES: u32 = 0x1C53_BB6B;
const CUE_POINT: u32 = 0xBB;
const CUE_TIME: u32 = 0xB3;
const CUE_TRACK_POSITIONS: u32 = 0xB7;
const CUE_TRACK: u32 = 0xF7;
const CUE_CLUSTER_POSITION: u32 = 0xF1;

/// The one track's number.
const TRACK: u8 = 1;
/// A track type of audio.
const AUDIO_TRACK: u64 = 2;

/// Writes one mono Opus stream into `out` as WebM. `push` each packet in
/// order, then `finish` with how many samples play.
pub struct OpusWebm<W: Write + Seek> {
    out: W,
    /// Where the Segment's body starts, which every position in it counts from.
    segment_body: u64,
    /// Where the Cues' position in the SeekHead is written, and the Duration.
    cues_position_at: u64,
    duration_at: u64,
    pre_skip: u64,
    /// The last packet pushed, held, since the last packet is written
    /// differently; every one before it is written.
    held: Option<Vec<u8>>,
    /// Packets pushed so far, the held one included.
    packets: u64,
    /// The Cluster being filled: its first packet's index, and its blocks.
    cluster: Option<(u64, Vec<u8>)>,
    /// Each Cluster written: its time in ticks and its position.
    cues: Vec<(u64, u64)>,
}

impl<W: Write + Seek> OpusWebm<W> {
    /// Start a stream whose encoder delays it by `pre_skip` samples at
    /// 48 kHz, from audio first recorded at `input_rate` (stated in
    /// `OpusHead`, for information).
    pub fn new(mut out: W, pre_skip: u16, input_rate: u32) -> io::Result<Self> {
        let mut head = enclosed(
            EBML,
            &[
                uint(EBML_VERSION, 1),
                uint(EBML_READ_VERSION, 1),
                uint(EBML_MAX_ID_LENGTH, 4),
                uint(EBML_MAX_SIZE_LENGTH, 8),
                string(DOC_TYPE, "webm"),
                uint(DOC_TYPE_VERSION, 4),
                uint(DOC_TYPE_READ_VERSION, 2),
            ]
            .concat(),
        );
        head.extend_from_slice(&id(SEGMENT));
        // Eight bytes, so the size written at the end fits whatever it is.
        head.extend_from_slice(&[0x01, 0, 0, 0, 0, 0, 0, 0]);
        let segment_body = out.stream_position()? + head.len() as u64;

        // Duration last, so its value is the Info's last eight bytes.
        let info = enclosed(
            INFO,
            &[
                uint(TIMESTAMP_SCALE, TICK_NS),
                string(MUXING_APP, WRITING_APP),
                string(WRITING_APP_ID, WRITING_APP),
                float(DURATION, 0.0),
            ]
            .concat(),
        );
        let tracks = enclosed(
            TRACKS,
            &enclosed(
                TRACK_ENTRY,
                &[
                    uint(TRACK_NUMBER, u64::from(TRACK)),
                    uint(TRACK_UID, 1),
                    uint(TRACK_TYPE, AUDIO_TRACK),
                    uint(FLAG_LACING, 0),
                    string(CODEC_ID, "A_OPUS"),
                    enclosed(CODEC_PRIVATE, &opus_head(pre_skip, input_rate)),
                    uint(CODEC_DELAY, to_ns(u64::from(pre_skip))),
                    uint(SEEK_PRE_ROLL, SEEK_PRE_ROLL_NS),
                    enclosed(
                        AUDIO,
                        &[
                            float(SAMPLING_FREQUENCY, OPUS_RATE as f64),
                            uint(CHANNELS, 1),
                        ]
                        .concat(),
                    ),
                ]
                .concat(),
            ),
        );
        // Every position in the SeekHead is eight bytes, so its length does
        // not depend on them; the Cues' is its last eight bytes.
        let seek_head = |info_at: u64, tracks_at: u64| {
            enclosed(
                SEEK_HEAD,
                &[
                    fixed_seek(INFO, info_at),
                    fixed_seek(TRACKS, tracks_at),
                    fixed_seek(CUES, 0),
                ]
                .concat(),
            )
        };
        let info_at = seek_head(0, 0).len() as u64;
        let tracks_at = info_at + info.len() as u64;
        head.extend_from_slice(&seek_head(info_at, tracks_at));
        head.extend_from_slice(&info);
        head.extend_from_slice(&tracks);
        out.write_all(&head)?;
        Ok(Self {
            out,
            segment_body,
            cues_position_at: segment_body + info_at - 8,
            duration_at: segment_body + tracks_at - 8,
            pre_skip: u64::from(pre_skip),
            held: None,
            packets: 0,
            cluster: None,
            cues: Vec::new(),
        })
    }

    /// Add the next 20 ms packet.
    pub fn push(&mut self, packet: &[u8]) -> io::Result<()> {
        if let Some(previous) = self.held.replace(packet.to_vec()) {
            let index = self.packets - 1;
            self.add_block(index, |body| {
                enclosed(SIMPLE_BLOCK, &block(body, &previous, 0x80))
            })?;
        }
        self.packets += 1;
        Ok(())
    }

    /// Write the last packet, trimmed so that `played` samples at 48 kHz
    /// play after the pre-skip, then the Cues, then the Segment's size, the
    /// Cues' position, and the Duration. Answers the writer, flushed.
    pub fn finish(mut self, played: u64) -> io::Result<W> {
        let Some(last) = self.held.take() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a stream without a packet has nothing to play",
            ));
        };
        let coded = self.packets * FRAME_48K;
        let Some(padding) = coded
            .checked_sub(self.pre_skip + played)
            .filter(|padding| *padding < FRAME_48K)
        else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "{} packets cannot play {played} samples after a pre-skip of {}",
                    self.packets, self.pre_skip
                ),
            ));
        };
        let index = self.packets - 1;
        self.add_block(index, |body| {
            enclosed(
                BLOCK_GROUP,
                &[
                    enclosed(BLOCK, &block(body, &last, 0)),
                    uint(BLOCK_DURATION, ticks(FRAME_48K)),
                    signed(DISCARD_PADDING, to_ns(padding) as i64),
                ]
                .concat(),
            )
        })?;
        self.write_cluster()?;

        let cues_position = self.out.stream_position()? - self.segment_body;
        let points: Vec<u8> = self
            .cues
            .iter()
            .flat_map(|&(time, position)| {
                enclosed(
                    CUE_POINT,
                    &[
                        uint(CUE_TIME, time),
                        enclosed(
                            CUE_TRACK_POSITIONS,
                            &[
                                uint(CUE_TRACK, u64::from(TRACK)),
                                uint(CUE_CLUSTER_POSITION, position),
                            ]
                            .concat(),
                        ),
                    ]
                    .concat(),
                )
            })
            .collect();
        self.out.write_all(&enclosed(CUES, &points))?;
        let end = self.out.stream_position()?;

        let duration_ms = played as f64 * 1_000.0 / OPUS_RATE as f64;
        for (at, bytes) in [
            (
                self.segment_body - 7,
                (end - self.segment_body).to_be_bytes()[1..].to_vec(),
            ),
            (self.cues_position_at, cues_position.to_be_bytes().to_vec()),
            (self.duration_at, duration_ms.to_be_bytes().to_vec()),
        ] {
            self.out.seek(SeekFrom::Start(at))?;
            self.out.write_all(&bytes)?;
        }
        self.out.seek(SeekFrom::Start(end))?;
        self.out.flush()?;
        Ok(self.out)
    }

    /// Add packet `index`'s block, made from its time within its Cluster,
    /// writing the Cluster before it when this one starts a new one. A
    /// Cluster holds the packets from a multiple of `CLUSTER_BLOCKS`.
    fn add_block(&mut self, index: u64, make: impl FnOnce(i16) -> Vec<u8>) -> io::Result<()> {
        let first = index - index % CLUSTER_BLOCKS;
        if self.cluster.as_ref().is_some_and(|(at, _)| *at != first) {
            self.write_cluster()?;
        }
        let (_, blocks) = self.cluster.get_or_insert_with(|| (first, Vec::new()));
        blocks.extend_from_slice(&make(ticks((index - first) * FRAME_48K) as i16));
        Ok(())
    }

    fn write_cluster(&mut self) -> io::Result<()> {
        let Some((first, blocks)) = self.cluster.take() else {
            return Ok(());
        };
        let time = ticks(first * FRAME_48K);
        let position = self.out.stream_position()? - self.segment_body;
        self.cues.push((time, position));
        let mut cluster = uint(TIMESTAMP, time);
        cluster.extend_from_slice(&blocks);
        self.out.write_all(&enclosed(CLUSTER, &cluster))
    }
}

/// A block's body: its track, its time from its Cluster's, its flags (a
/// SimpleBlock's keyframe bit), then the packet.
fn block(time: i16, packet: &[u8], flags: u8) -> Vec<u8> {
    let mut body = Vec::with_capacity(packet.len() + 4);
    body.push(0x80 | TRACK);
    body.extend_from_slice(&time.to_be_bytes());
    body.push(flags);
    body.extend_from_slice(packet);
    body
}

/// Samples at 48 kHz in Info ticks (milliseconds); every time here is a
/// whole number of 20 ms packets.
fn ticks(samples: u64) -> u64 {
    samples * 1_000 / OPUS_RATE
}

/// `OpusHead` (RFC 7845, section 5.1), for one channel.
fn opus_head(pre_skip: u16, input_rate: u32) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(1); // channels
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&input_rate.to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family: mono or stereo
    head
}

/// Samples at 48 kHz in nanoseconds, rounded.
fn to_ns(samples: u64) -> u64 {
    (samples * 1_000_000_000 + OPUS_RATE / 2) / OPUS_RATE
}

/// An element ID's bytes: its marker bits are part of it.
fn id(id: u32) -> Vec<u8> {
    let bytes = id.to_be_bytes();
    let skip = (id.leading_zeros() / 8) as usize;
    bytes[skip..].to_vec()
}

/// An element size as the shortest variable-length integer that holds it.
/// All ones means "unknown", so a length's largest value is never used.
fn size(value: u64) -> Vec<u8> {
    let length = (1..=8)
        .find(|length| value < (1u64 << (7 * length)) - 1)
        .expect("a size below 2^56");
    let marked = value | (1u64 << (7 * length));
    marked.to_be_bytes()[8 - length..].to_vec()
}

/// An element: its ID, its body's size, its body.
fn enclosed(element_id: u32, body: &[u8]) -> Vec<u8> {
    [id(element_id), size(body.len() as u64), body.to_vec()].concat()
}

/// An unsigned integer element in as few bytes as hold it, at least one.
fn uint(element_id: u32, value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let skip = ((value.leading_zeros() / 8) as usize).min(7);
    enclosed(element_id, &bytes[skip..])
}

/// A signed integer element in as few bytes as keep its sign.
fn signed(element_id: u32, value: i64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let mut skip = 0;
    while skip < 7
        && ((bytes[skip] == 0 && bytes[skip + 1] & 0x80 == 0)
            || (bytes[skip] == 0xFF && bytes[skip + 1] & 0x80 != 0))
    {
        skip += 1;
    }
    enclosed(element_id, &bytes[skip..])
}

fn float(element_id: u32, value: f64) -> Vec<u8> {
    enclosed(element_id, &value.to_be_bytes())
}

fn string(element_id: u32, value: &str) -> Vec<u8> {
    enclosed(element_id, value.as_bytes())
}

/// A Seek naming `target` at `position`, the position in eight bytes so it
/// can be written again in place.
fn fixed_seek(target: u32, position: u64) -> Vec<u8> {
    let mut position_element = id(SEEK_POSITION);
    position_element.push(0x88);
    position_element.extend_from_slice(&position.to_be_bytes());
    enclosed(
        SEEK,
        &[enclosed(SEEK_ID, &id(target)), position_element].concat(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// An element read back: its ID, where it starts in the file, its body,
    /// and its children when it is a master element.
    struct Read {
        id: u32,
        start: usize,
        body: Vec<u8>,
        children: Vec<Read>,
    }

    const MASTERS: [u32; 12] = [
        EBML,
        SEGMENT,
        SEEK_HEAD,
        SEEK,
        INFO,
        TRACKS,
        TRACK_ENTRY,
        AUDIO,
        CLUSTER,
        BLOCK_GROUP,
        CUES,
        CUE_POINT,
    ];

    fn vint(bytes: &[u8], at: usize, keep_marker: bool) -> (u64, usize) {
        let length = bytes[at].leading_zeros() as usize + 1;
        let first = if keep_marker {
            bytes[at]
        } else {
            bytes[at] & 0xFFu8.checked_shr(length as u32).unwrap_or(0)
        };
        let value = bytes[at + 1..at + length]
            .iter()
            .fold(u64::from(first), |value, &byte| {
                (value << 8) | u64::from(byte)
            });
        (value, length)
    }

    /// Every element from `at` to `end`, each read whole; this writer never
    /// leaves a size unknown.
    fn read(bytes: &[u8], mut at: usize, end: usize) -> Vec<Read> {
        let mut elements = Vec::new();
        while at < end {
            let (id, id_length) = vint(bytes, at, true);
            let (size, size_length) = vint(bytes, at + id_length, false);
            let body = at + id_length + size_length;
            let close = body + size as usize;
            assert!(close <= end, "element {id:#x} at {at} runs past its parent");
            let id = id as u32;
            elements.push(Read {
                id,
                start: at,
                body: bytes[body..close].to_vec(),
                children: if MASTERS.contains(&id) || id == CUE_TRACK_POSITIONS {
                    read(bytes, body, close)
                } else {
                    Vec::new()
                },
            });
            at = close;
        }
        elements
    }

    impl Read {
        fn all(&self, id: u32) -> Vec<&Read> {
            self.children
                .iter()
                .filter(|child| child.id == id)
                .collect()
        }
        fn one(&self, id: u32) -> &Read {
            let found = self.all(id);
            assert_eq!(found.len(), 1, "one {id:#x} in {:#x}", self.id);
            found[0]
        }
        fn uint(&self) -> u64 {
            self.body
                .iter()
                .fold(0, |value, &byte| (value << 8) | u64::from(byte))
        }
    }

    /// `count` packets, as many as the encoder would make for `played`
    /// samples after a 312-sample pre-skip, written as a stopped recording
    /// would be.
    fn written(count: u64, played: u64) -> Vec<u8> {
        let mut webm = OpusWebm::new(Cursor::new(Vec::new()), 312, 16_000).unwrap();
        for index in 0..count {
            webm.push(&[0xF8, index as u8, (index >> 8) as u8]).unwrap();
        }
        webm.finish(played).unwrap().into_inner()
    }

    /// The fields Safari and Chromium read to play an Opus stream from its
    /// first sample to its last, and to seek in it.
    #[test]
    fn a_stream_is_written_with_what_a_player_needs_to_play_it_exactly() {
        // 251 packets: two Clusters, the last packet padded by 100 samples.
        let played = 251 * FRAME_48K - 312 - 100;
        let bytes = written(251, played);
        let top = read(&bytes, 0, bytes.len());
        assert_eq!(
            top.len(),
            2,
            "an EBML header and one Segment, nothing after"
        );

        let header = &top[0];
        assert_eq!(header.id, EBML);
        assert_eq!(header.one(DOC_TYPE).body, b"webm");
        assert_eq!(header.one(DOC_TYPE_VERSION).uint(), 4);

        let segment = &top[1];
        assert_eq!(segment.id, SEGMENT);
        let segment_body = segment.start + 12;
        let at = |position: u64| {
            segment
                .children
                .iter()
                .find(|child| child.start == segment_body + position as usize)
                .map(|child| child.id)
        };
        for seek in segment.one(SEEK_HEAD).all(SEEK) {
            let target = seek.one(SEEK_ID).uint() as u32;
            assert_eq!(at(seek.one(SEEK_POSITION).uint()), Some(target));
        }
        assert_eq!(segment.one(SEEK_HEAD).all(SEEK).len(), 3);

        let info = segment.one(INFO);
        assert_eq!(info.one(TIMESTAMP_SCALE).uint(), 1_000_000);
        let duration = f64::from_be_bytes(info.one(DURATION).body.clone().try_into().unwrap());
        assert_eq!(duration, played as f64 / 48.0);

        let track = segment.one(TRACKS).one(TRACK_ENTRY);
        assert_eq!(track.one(CODEC_ID).body, b"A_OPUS");
        let head = &track.one(CODEC_PRIVATE).body;
        assert_eq!(&head[..8], b"OpusHead");
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), 312);
        assert_eq!(track.one(CODEC_DELAY).uint(), 6_500_000);
        assert_eq!(track.one(SEEK_PRE_ROLL).uint(), 80_000_000);
        assert_eq!(track.one(AUDIO).one(CHANNELS).uint(), 1);

        let clusters = segment.all(CLUSTER);
        assert_eq!(clusters.len(), 2);
        assert_eq!(clusters[0].one(TIMESTAMP).uint(), 0);
        assert_eq!(clusters[1].one(TIMESTAMP).uint(), 5_000);
        assert_eq!(clusters[0].all(SIMPLE_BLOCK).len(), 250);
        let times: Vec<i16> = clusters[0]
            .all(SIMPLE_BLOCK)
            .iter()
            .map(|block| i16::from_be_bytes([block.body[1], block.body[2]]))
            .collect();
        assert_eq!(times[1], 20);
        assert_eq!(times[249], 4_980);
        // The last packet alone is in a BlockGroup, trimmed.
        assert!(clusters[1].all(SIMPLE_BLOCK).is_empty());
        let group = clusters[1].one(BLOCK_GROUP);
        assert_eq!(group.one(BLOCK).body[4..], [0xF8, 250, 0]);
        assert_eq!(group.one(DISCARD_PADDING).uint(), 2_083_333);

        let cues = segment.one(CUES).all(CUE_POINT);
        assert_eq!(cues.len(), 2);
        for (cue, cluster) in cues.iter().zip(&clusters) {
            assert_eq!(cue.one(CUE_TIME).uint(), cluster.one(TIMESTAMP).uint());
            let position = cue
                .one(CUE_TRACK_POSITIONS)
                .one(CUE_CLUSTER_POSITION)
                .uint();
            assert_eq!(segment_body + position as usize, cluster.start);
        }
    }

    #[test]
    fn a_stream_that_does_not_add_up_is_refused() {
        let webm = OpusWebm::new(Cursor::new(Vec::new()), 312, 16_000).unwrap();
        assert!(webm.finish(0).is_err(), "no packet");
        // More than the packets hold; a whole packet more than they hold.
        for (packets, played) in [(1, 2 * FRAME_48K), (2, 0)] {
            let mut webm = OpusWebm::new(Cursor::new(Vec::new()), 312, 16_000).unwrap();
            for _ in 0..packets {
                webm.push(&[0xF8]).unwrap();
            }
            assert!(webm.finish(played).is_err(), "{packets} for {played}");
        }
    }
}
