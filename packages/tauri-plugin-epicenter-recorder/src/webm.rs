//! The container a recording is written in from its first sample: Opus in
//! WebM, laid out as the Matroska Opus mapping says and as `ffmpeg` writes
//! it, which Safari and Chromium both play and decode to the exact length.
//!
//! While it records ([`LiveWebm`]):
//!
//! - an EBML header (`webm`, version 4, for `DiscardPadding`);
//! - one Segment whose size is unknown (eight bytes, `01 FF..FF`);
//! - a SeekHead naming Info and Tracks, then a Void where the Cues' Seek
//!   goes;
//! - Info: millisecond ticks, then a Void where the Duration goes;
//! - one `A_OPUS` track: `OpusHead` as its CodecPrivate, the pre-skip again
//!   as CodecDelay, and 80 ms of SeekPreRoll;
//! - Clusters of 50 SimpleBlocks, one 20 ms packet each: a second. A
//!   Cluster is held in memory until the next packet does not fit, then
//!   written whole, its size known, in one write. Nothing is written back
//!   into a Cluster, so a file cut off at any moment is whole Clusters,
//!   with at most a torn one at its end, and a crash loses at most the
//!   second held.
//!
//! Finishing ([`LiveWebm::finish`] at Stop, [`finish_cut_off`] for a file a
//! crash left) states what the file holds, in an order that makes the
//! Segment's size the mark of a finished file:
//!
//! 1. the last Cluster, from memory, its last packet in a BlockGroup whose
//!    DiscardPadding trims what the encoder padded the end with (a cut-off
//!    file keeps its Clusters as they are: nothing to trim);
//! 2. Cues, one per Cluster;
//! 3. the Cues' Seek and the Duration, each over its Void;
//! 4. flushed to the disk, then the Segment's size, flushed again.
//!
//! A file whose Segment states its size is finished, and `finish_cut_off`
//! leaves it alone. One cut off anywhere before that is finished again
//! from its whole Clusters, whatever the cut tore.
//!
//! A block's time is where its packet starts in the encoded stream,
//! pre-skip included; a player subtracts CodecDelay.

use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;

/// libopus decodes at 48 kHz; Matroska's Opus times and paddings count at it.
pub const OPUS_RATE: u64 = 48_000;
/// Every packet holds 20 ms.
pub const FRAME_48K: u64 = 960;
/// Packets per Cluster: a second, the most a crash loses.
pub const CLUSTER_PACKETS: usize = 50;
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
const VOID: u32 = 0xEC;

/// The one track's number.
const TRACK: u8 = 1;
/// A track type of audio.
const AUDIO_TRACK: u64 = 2;
/// A Seek with an eight-byte position, whose place a Void holds.
const SEEK_LENGTH: usize = 21;
/// A Duration, whose place a Void holds.
const DURATION_LENGTH: usize = 11;
/// An eight-byte size that says "unknown".
const UNKNOWN_SIZE: [u8; 8] = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

/// Where a recording is written: its file, or in a test, one whose disk
/// fills.
pub trait Storage: Write + Seek + Send {
    /// Cut it to `length` bytes.
    fn set_len(&mut self, length: u64) -> io::Result<()>;
    /// Flush what was written to the disk.
    fn sync_data(&mut self) -> io::Result<()>;
}

impl Storage for File {
    fn set_len(&mut self, length: u64) -> io::Result<()> {
        File::set_len(self, length)
    }

    fn sync_data(&mut self) -> io::Result<()> {
        File::sync_data(self)
    }
}

/// Where finishing writes back into a file's head, and where positions in
/// its Segment count from.
#[derive(Clone, Copy, Debug)]
struct Layout {
    /// Where the Segment's body starts, in the file.
    segment_body: u64,
    /// Where the SeekHead starts, in the file.
    seek_head_at: u64,
    /// Info's and Tracks' positions in the Segment, which the SeekHead names.
    info_at: u64,
    tracks_at: u64,
    /// Where the Duration's Void is, in the file.
    duration_at: u64,
    pre_skip: u64,
}

/// One mono Opus stream written into `out` as WebM while it records. `push`
/// each packet in order, then `finish` with how many samples play.
pub struct LiveWebm<S: Storage> {
    out: S,
    layout: Layout,
    /// Packets pushed so far, those held included.
    packets: u64,
    /// The index of the held Cluster's first packet.
    first: u64,
    /// The Cluster being filled.
    held: Vec<Vec<u8>>,
    /// Each Cluster written: its time in ticks and its position.
    cues: Vec<(u64, u64)>,
    /// Where the Clusters written so far end.
    end: u64,
}

impl<S: Storage> LiveWebm<S> {
    /// Start a stream whose encoder delays it by `pre_skip` samples at
    /// 48 kHz, from audio recorded at `input_rate` (stated in `OpusHead`,
    /// for information), writing its head into `out`.
    pub fn new(mut out: S, pre_skip: u16, input_rate: u32) -> io::Result<Self> {
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
        head.extend_from_slice(&UNKNOWN_SIZE);
        let segment_body = head.len() as u64;
        let info = enclosed(
            INFO,
            &[
                uint(TIMESTAMP_SCALE, TICK_NS),
                string(MUXING_APP, WRITING_APP),
                string(WRITING_APP_ID, WRITING_APP),
                void(DURATION_LENGTH),
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
        // The SeekHead is as long with the Cues' Seek as with its Void.
        let info_at = seek_head(0, 0, None).len() as u64;
        let tracks_at = info_at + info.len() as u64;
        head.extend_from_slice(&seek_head(info_at, tracks_at, None));
        head.extend_from_slice(&info);
        head.extend_from_slice(&tracks);
        out.write_all(&head)?;
        Ok(Self {
            out,
            layout: Layout {
                segment_body,
                seek_head_at: segment_body,
                info_at,
                tracks_at,
                duration_at: segment_body + tracks_at - DURATION_LENGTH as u64,
                pre_skip: u64::from(pre_skip),
            },
            packets: 0,
            first: 0,
            held: Vec::with_capacity(CLUSTER_PACKETS),
            cues: Vec::new(),
            end: head.len() as u64,
        })
    }

    /// Add the next 20 ms packet, writing the held Cluster first when it is
    /// full. A Cluster the disk refuses is cut back off the file, which
    /// keeps the Clusters before it, and the packet is not added.
    pub fn push(&mut self, packet: &[u8]) -> io::Result<()> {
        if self.held.len() == CLUSTER_PACKETS {
            let bytes = cluster(self.first, &self.held, None);
            append(&mut self.out, self.end, &bytes)?;
            self.cues.push((
                ticks(self.first * FRAME_48K),
                self.end - self.layout.segment_body,
            ));
            self.end += bytes.len() as u64;
            self.first += self.held.len() as u64;
            self.held.clear();
        }
        self.held.push(packet.to_vec());
        self.packets += 1;
        Ok(())
    }

    /// Packets pushed so far.
    pub fn packets(&self) -> u64 {
        self.packets
    }

    /// Write the held Cluster, its last packet trimmed so that `played`
    /// samples at 48 kHz play after the pre-skip, and finish the file.
    /// Answers where it was written. On an error the file still holds its
    /// whole Clusters, for [`finish_cut_off`].
    pub fn finish(mut self, played: u64) -> io::Result<S> {
        if self.held.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a stream without a packet has nothing to play",
            ));
        }
        let coded = self.packets * FRAME_48K;
        let Some(padding) = coded
            .checked_sub(self.layout.pre_skip + played)
            .filter(|padding| *padding < FRAME_48K)
        else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "{} packets cannot play {played} samples after a pre-skip of {}",
                    self.packets, self.layout.pre_skip
                ),
            ));
        };
        let last = (self.first, cluster(self.first, &self.held, Some(padding)));
        close(
            &mut self.out,
            &self.layout,
            self.cues,
            self.end,
            Some(last),
            played,
        )?;
        Ok(self.out)
    }
}

/// Write `bytes` at `end`, or leave the file ending at `end`.
fn append<S: Storage>(out: &mut S, end: u64, bytes: &[u8]) -> io::Result<()> {
    let written = out
        .seek(SeekFrom::Start(end))
        .and_then(|_| out.write_all(bytes));
    if written.is_err() {
        let _ = out.set_len(end);
    }
    written
}

/// Finish a file whose Clusters end at `end`: append `last` (the index of
/// its first packet, and its bytes) and then the Cues, and state the Cues'
/// position, the Duration of `played` samples, and last the Segment's size.
fn close<S: Storage>(
    out: &mut S,
    layout: &Layout,
    mut cues: Vec<(u64, u64)>,
    end: u64,
    last: Option<(u64, Vec<u8>)>,
    played: u64,
) -> io::Result<()> {
    let mut tail = Vec::new();
    if let Some((first, bytes)) = last {
        cues.push((ticks(first * FRAME_48K), end - layout.segment_body));
        tail = bytes;
    }
    let cues_position = end + tail.len() as u64 - layout.segment_body;
    let points: Vec<u8> = cues
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
    tail.extend_from_slice(&enclosed(CUES, &points));
    append(out, end, &tail)?;
    let finished = end + tail.len() as u64;
    let duration_ms = played as f64 * 1_000.0 / OPUS_RATE as f64;
    for (at, bytes) in [
        (
            layout.seek_head_at,
            seek_head(layout.info_at, layout.tracks_at, Some(cues_position)),
        ),
        (layout.duration_at, float(DURATION, duration_ms)),
    ] {
        out.seek(SeekFrom::Start(at))?;
        out.write_all(&bytes)?;
    }
    // Everything else is on the disk before the size says it is finished.
    out.sync_data()?;
    let mut size = (finished - layout.segment_body).to_be_bytes();
    size[0] = 0x01;
    out.seek(SeekFrom::Start(layout.segment_body - 8))?;
    out.write_all(&size)?;
    out.sync_data()?;
    out.seek(SeekFrom::Start(finished))?;
    Ok(())
}

/// A Cluster of `packets` from packet index `first`; with `last_padding`,
/// its last packet in a BlockGroup with that DiscardPadding.
fn cluster(first: u64, packets: &[Vec<u8>], last_padding: Option<u64>) -> Vec<u8> {
    let mut body = uint(TIMESTAMP, ticks(first * FRAME_48K));
    for (index, packet) in packets.iter().enumerate() {
        let time = ticks(index as u64 * FRAME_48K) as i16;
        match last_padding {
            Some(padding) if index + 1 == packets.len() => body.extend_from_slice(&enclosed(
                BLOCK_GROUP,
                &[
                    enclosed(BLOCK, &block(time, packet, 0)),
                    uint(BLOCK_DURATION, ticks(FRAME_48K)),
                    signed(DISCARD_PADDING, to_ns(padding) as i64),
                ]
                .concat(),
            )),
            _ => body.extend_from_slice(&enclosed(SIMPLE_BLOCK, &block(time, packet, 0x80))),
        }
    }
    enclosed(CLUSTER, &body)
}

/// The SeekHead: Info, Tracks, and the Cues, or a Void in the Cues' place.
/// Every position is eight bytes, so its length does not depend on them.
fn seek_head(info_at: u64, tracks_at: u64, cues_at: Option<u64>) -> Vec<u8> {
    let cues = match cues_at {
        Some(at) => fixed_seek(CUES, at),
        None => void(SEEK_LENGTH),
    };
    enclosed(
        SEEK_HEAD,
        &[
            fixed_seek(INFO, info_at),
            fixed_seek(TRACKS, tracks_at),
            cues,
        ]
        .concat(),
    )
}

// ---------------------------------------------------------------- recovery

/// What [`finish_cut_off`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CutOff {
    /// Already finished: nothing was written. Holds the samples at 48 kHz
    /// that play.
    Finished { played: u64 },
    /// Cut off, and now finished with every whole Cluster it held.
    Recovered { played: u64 },
    /// No whole Cluster, or not even a whole head: it holds no audio.
    /// Nothing was written.
    Empty,
}

/// Finish the recording at `path` that a crash or a full disk cut off, in
/// place, from its whole Clusters; a torn Cluster at its end is dropped. A
/// finished file is left alone, so running it twice writes once. On an
/// error the file still holds its whole Clusters, for the next try.
pub fn finish_cut_off(path: &Path) -> io::Result<CutOff> {
    let bytes = std::fs::read(path)?;
    let mut out = File::options().write(true).open(path)?;
    finish_cut_off_in(&bytes, &mut out)
}

/// [`finish_cut_off`] of a file holding `bytes`, written through `out`.
fn finish_cut_off_in<S: Storage>(bytes: &[u8], out: &mut S) -> io::Result<CutOff> {
    let Some(scan) = scan(bytes) else {
        return Ok(CutOff::Empty);
    };
    if let Some(played) = scan.finished {
        return Ok(CutOff::Finished { played });
    }
    let Some(last) = scan.clusters.last() else {
        return Ok(CutOff::Empty);
    };
    let packets: u64 = scan.clusters.iter().map(|cluster| cluster.packets).sum();
    let played = (packets * FRAME_48K)
        .checked_sub(scan.layout.pre_skip + last.padding)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "its Clusters hold less than the encoder's delay",
            )
        })?;
    let cues = scan
        .clusters
        .iter()
        .map(|cluster| (cluster.time, cluster.start - scan.layout.segment_body))
        .collect();
    out.set_len(last.end)?;
    close(out, &scan.layout, cues, last.end, None, played)?;
    Ok(CutOff::Recovered { played })
}

/// What a file holds, read back.
struct Scan {
    layout: Layout,
    /// The samples at 48 kHz it plays, when it is finished: its Segment
    /// states its length, and it has its Duration and Cues.
    finished: Option<u64>,
    /// The run of whole Clusters from the first, each at the time the
    /// packets before it end.
    clusters: Vec<ClusterRead>,
}

/// A whole Cluster read back.
struct ClusterRead {
    start: u64,
    end: u64,
    /// Its time in ticks.
    time: u64,
    packets: u64,
    /// Its last packet's DiscardPadding, at 48 kHz.
    padding: u64,
}

/// One element read back.
#[derive(Clone, Copy)]
struct Element {
    id: u32,
    start: usize,
    body: usize,
    end: usize,
}

/// Read `bytes` as this module writes a recording, or `None` when not even
/// its head is whole.
fn scan(bytes: &[u8]) -> Option<Scan> {
    let length = bytes.len();
    let ebml = element(bytes, 0, length).filter(|element| element.id == EBML)?;
    // The Segment's size, eight bytes: unknown until it is finished.
    let (segment_id, id_length) = vint(bytes, ebml.end, true)?;
    let (stated, size_length) = vint(bytes, ebml.end + id_length, false)?;
    if segment_id as u32 != SEGMENT || size_length != 8 {
        return None;
    }
    let segment_body = ebml.end + id_length + size_length;
    let sized = stated != (1u64 << 56) - 1;
    let segment_end = if sized {
        usize::try_from(stated).ok()?.checked_add(segment_body)?
    } else {
        length
    };
    let limit = segment_end.min(length);

    let mut at = segment_body;
    let mut take = |want: u32| {
        let found = element(bytes, at, limit).filter(|element| element.id == want)?;
        at = found.end;
        Some(found)
    };
    let seek_head = take(SEEK_HEAD)?;
    let info = take(INFO)?;
    let tracks = take(TRACKS)?;
    let slot = *children(bytes, &info)?.last()?;
    if slot.end - slot.start != DURATION_LENGTH || !(slot.id == VOID || slot.id == DURATION) {
        return None;
    }
    let entry = children(bytes, &tracks)?
        .into_iter()
        .find(|element| element.id == TRACK_ENTRY)?;
    let private = children(bytes, &entry)?
        .into_iter()
        .find(|element| element.id == CODEC_PRIVATE)?;
    let head = &bytes[private.body..private.end];
    if head.len() < 19 || &head[..8] != b"OpusHead" {
        return None;
    }
    let layout = Layout {
        segment_body: segment_body as u64,
        seek_head_at: seek_head.start as u64,
        info_at: (info.start - segment_body) as u64,
        tracks_at: (tracks.start - segment_body) as u64,
        duration_at: slot.start as u64,
        pre_skip: u64::from(u16::from_le_bytes([head[10], head[11]])),
    };

    let mut clusters: Vec<ClusterRead> = Vec::new();
    let mut packets = 0;
    let mut has_cues = false;
    let mut cursor = tracks.end;
    while let Some(found) = element(bytes, cursor, limit) {
        if found.id == CUES {
            has_cues = true;
            break;
        }
        let Some(read) = (found.id == CLUSTER)
            .then(|| read_cluster(bytes, &found))
            .flatten()
            .filter(|read| read.time == ticks(packets * FRAME_48K))
        else {
            break;
        };
        packets += read.packets;
        cursor = found.end;
        clusters.push(read);
    }
    let finished = (sized && segment_end == length && slot.id == DURATION && has_cues).then(|| {
        let value: [u8; 8] = bytes[slot.end - 8..slot.end]
            .try_into()
            .expect("eight bytes");
        (f64::from_be_bytes(value) * OPUS_RATE as f64 / 1_000.0).round() as u64
    });
    Some(Scan {
        layout,
        finished,
        clusters,
    })
}

/// A whole Cluster's time, how many packets it holds, and the
/// DiscardPadding of its last; `None` for anything else.
fn read_cluster(bytes: &[u8], cluster: &Element) -> Option<ClusterRead> {
    let mut time = None;
    let mut packets = 0;
    let mut padding = 0;
    let is_block = |element: &Element| {
        let body = &bytes[element.body..element.end];
        body.len() > 4 && body[0] == 0x80 | TRACK
    };
    for child in children(bytes, cluster)? {
        match child.id {
            TIMESTAMP => time = Some(read_uint(bytes, &child)),
            SIMPLE_BLOCK if is_block(&child) => {
                packets += 1;
                padding = 0;
            }
            BLOCK_GROUP => {
                let parts = children(bytes, &child)?;
                if !parts.iter().any(|part| part.id == BLOCK && is_block(part)) {
                    return None;
                }
                packets += 1;
                padding = parts
                    .iter()
                    .find(|part| part.id == DISCARD_PADDING)
                    .map_or(0, |part| {
                        let ns = read_signed(bytes, part).max(0) as u64;
                        (ns * OPUS_RATE + 500_000_000) / 1_000_000_000
                    });
            }
            _ => return None,
        }
    }
    Some(ClusterRead {
        start: cluster.start as u64,
        end: cluster.end as u64,
        time: time?,
        packets,
        padding,
    })
}

/// A variable-length integer at `at`, with its length marker or without,
/// and its length.
fn vint(bytes: &[u8], at: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *bytes.get(at)?;
    if first == 0 {
        return None;
    }
    let length = first.leading_zeros() as usize + 1;
    let rest = bytes.get(at + 1..at + length)?;
    let first = if keep_marker {
        first
    } else {
        first & 0xFFu8.checked_shr(length as u32).unwrap_or(0)
    };
    let value = rest.iter().fold(u64::from(first), |value, &byte| {
        (value << 8) | u64::from(byte)
    });
    Some((value, length))
}

/// The element at `at`, of a known size and whole within `limit`.
fn element(bytes: &[u8], at: usize, limit: usize) -> Option<Element> {
    let (id, id_length) = vint(bytes, at, true)?;
    let (size, size_length) = vint(bytes, at + id_length, false)?;
    if id_length > 4 || size == (1u64 << (7 * size_length)) - 1 {
        return None;
    }
    let body = at + id_length + size_length;
    let end = body.checked_add(usize::try_from(size).ok()?)?;
    (end <= limit).then_some(Element {
        id: id as u32,
        start: at,
        body,
        end,
    })
}

/// Every child of `parent`, each whole.
fn children(bytes: &[u8], parent: &Element) -> Option<Vec<Element>> {
    let mut found = Vec::new();
    let mut at = parent.body;
    while at < parent.end {
        let child = element(bytes, at, parent.end)?;
        at = child.end;
        found.push(child);
    }
    Some(found)
}

fn read_uint(bytes: &[u8], element: &Element) -> u64 {
    bytes[element.body..element.end]
        .iter()
        .fold(0, |value, &byte| (value << 8) | u64::from(byte))
}

fn read_signed(bytes: &[u8], element: &Element) -> i64 {
    let value = &bytes[element.body..element.end];
    let value = &value[value.len().saturating_sub(8)..];
    let sign = if value.first().is_some_and(|byte| byte & 0x80 != 0) {
        0xFF
    } else {
        0
    };
    let mut extended = [sign; 8];
    extended[8 - value.len()..].copy_from_slice(value);
    i64::from_be_bytes(extended)
}

// ---------------------------------------------------------------- elements

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

/// A Void element `total` bytes long, from 2 to 128.
fn void(total: usize) -> Vec<u8> {
    enclosed(VOID, &vec![0u8; total - 2])
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
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    impl Storage for Cursor<Vec<u8>> {
        fn set_len(&mut self, length: u64) -> io::Result<()> {
            self.get_mut().resize(length as usize, 0);
            Ok(())
        }
        fn sync_data(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A file on a disk with room for `room` bytes of it: a write past that
    /// writes what fits and then fails as a full disk does, and cutting the
    /// file frees what it held.
    pub(crate) struct FullDisk {
        pub(crate) file: File,
        pub(crate) room: u64,
    }

    impl Write for FullDisk {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let at = self.file.stream_position()?;
            let fits = self.room.saturating_sub(at).min(buf.len() as u64) as usize;
            if fits == 0 && !buf.is_empty() {
                return Err(io::Error::from_raw_os_error(28));
            }
            self.file.write(&buf[..fits])
        }
        fn flush(&mut self) -> io::Result<()> {
            self.file.flush()
        }
    }

    impl Seek for FullDisk {
        fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
            self.file.seek(to)
        }
    }

    impl Storage for FullDisk {
        fn set_len(&mut self, length: u64) -> io::Result<()> {
            self.file.set_len(length)
        }
        fn sync_data(&mut self) -> io::Result<()> {
            self.file.sync_data()
        }
    }

    /// An element read back: its ID, where it starts in the file, its body,
    /// and its children when it is a master element.
    struct Read {
        id: u32,
        start: usize,
        body: Vec<u8>,
        children: Vec<Read>,
    }

    const MASTERS: [u32; 13] = [
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
        CUE_TRACK_POSITIONS,
    ];

    /// Every element from `at` to `end`, each read whole.
    fn read(bytes: &[u8], mut at: usize, end: usize) -> Vec<Read> {
        let mut elements = Vec::new();
        while at < end {
            let found = element(bytes, at, end).expect("a whole element of a known size");
            elements.push(Read {
                id: found.id,
                start: at,
                body: bytes[found.body..found.end].to_vec(),
                children: if MASTERS.contains(&found.id) {
                    read(bytes, found.body, found.end)
                } else {
                    Vec::new()
                },
            });
            at = found.end;
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

    const PRE_SKIP: u64 = 312;

    /// `count` stand-in packets pushed, with a 312-sample pre-skip, and not
    /// finished.
    fn live(count: u64) -> LiveWebm<Cursor<Vec<u8>>> {
        let mut webm = LiveWebm::new(Cursor::new(Vec::new()), PRE_SKIP as u16, 16_000).unwrap();
        for index in 0..count {
            webm.push(&[0xF8, index as u8, (index >> 8) as u8]).unwrap();
        }
        webm
    }

    /// The bytes on the disk of `count` packets pushed: what a crash leaves.
    fn cut_off(count: u64) -> Vec<u8> {
        live(count).out.into_inner()
    }

    /// `count` packets pushed and finished to play `played` samples.
    fn finished(count: u64, played: u64) -> Vec<u8> {
        live(count).finish(played).unwrap().into_inner()
    }

    /// `finish_cut_off` of `bytes`, and the file it leaves.
    fn recovered(bytes: &[u8]) -> (CutOff, Vec<u8>) {
        let mut out = Cursor::new(bytes.to_vec());
        let found = finish_cut_off_in(bytes, &mut out).unwrap();
        (found, out.into_inner())
    }

    /// The fields Safari and Chromium read to play an Opus stream from its
    /// first sample to its last, and to seek in it.
    #[test]
    fn a_finished_stream_has_what_a_player_needs_to_play_it_exactly() {
        // 51 packets: two Clusters, the last packet padded by 100 samples.
        let played = 51 * FRAME_48K - PRE_SKIP - 100;
        let bytes = finished(51, played);
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
        let seeks = segment.one(SEEK_HEAD).all(SEEK);
        assert_eq!(seeks.len(), 3);
        for seek in seeks {
            let target = seek.one(SEEK_ID).uint() as u32;
            assert_eq!(at(seek.one(SEEK_POSITION).uint()), Some(target));
        }

        let info = segment.one(INFO);
        assert_eq!(info.one(TIMESTAMP_SCALE).uint(), 1_000_000);
        let duration = f64::from_be_bytes(info.one(DURATION).body.clone().try_into().unwrap());
        assert_eq!(duration, played as f64 / 48.0);
        assert!(info.all(VOID).is_empty() && segment.one(SEEK_HEAD).all(VOID).is_empty());

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
        assert_eq!(clusters[1].one(TIMESTAMP).uint(), 1_000);
        assert_eq!(clusters[0].all(SIMPLE_BLOCK).len(), 50);
        let times: Vec<i16> = clusters[0]
            .all(SIMPLE_BLOCK)
            .iter()
            .map(|block| i16::from_be_bytes([block.body[1], block.body[2]]))
            .collect();
        assert_eq!(times[1], 20);
        assert_eq!(times[49], 980);
        // The last packet alone is in a BlockGroup, trimmed.
        assert!(clusters[1].all(SIMPLE_BLOCK).is_empty());
        let group = clusters[1].one(BLOCK_GROUP);
        assert_eq!(group.one(BLOCK).body[4..], [0xF8, 50, 0]);
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
        assert_eq!(recovered(&bytes), (CutOff::Finished { played }, bytes));
    }

    #[test]
    fn a_stream_that_does_not_add_up_is_refused() {
        assert!(live(0).finish(0).is_err(), "no packet");
        // More than the packets hold; a whole packet more than they hold.
        for (packets, played) in [(1, 2 * FRAME_48K), (2, 0)] {
            assert!(
                live(packets).finish(played).is_err(),
                "{packets} for {played}"
            );
        }
    }

    /// Nothing reaches the file but the head until a Cluster is whole, and
    /// a Cluster reaches it whole: the file is always its head and whole
    /// Clusters, so a crash loses at most the Cluster held.
    #[test]
    fn a_cluster_reaches_the_file_whole_once_the_next_packet_does_not_fit() {
        let head = cut_off(0).len();
        assert_eq!(cut_off(50).len(), head, "the first second is held");
        let one = cut_off(51);
        assert!(one.len() > head);
        assert_eq!(cut_off(100), one, "the second second is held");
        let ebml = element(&one, 0, head).unwrap();
        assert_eq!(
            one[ebml.end + 4..ebml.end + 12],
            UNKNOWN_SIZE,
            "the Segment's size is not known yet"
        );
        let cluster = element(&one, head, one.len()).unwrap();
        assert_eq!((cluster.id, cluster.end), (CLUSTER, one.len()));
    }

    /// Stop writes what is held, the Cues, and three small values back:
    /// nothing in it grows with the recording but the Cues, a few bytes a
    /// second, and nothing is encoded.
    #[test]
    fn finishing_an_hour_writes_only_its_last_second_and_its_cues() {
        let hour = 3_600 * 50;
        let webm = live(hour);
        let before = webm.out.get_ref().len();
        let started = std::time::Instant::now();
        let bytes = webm
            .finish(hour * FRAME_48K - PRE_SKIP)
            .unwrap()
            .into_inner();
        let took = started.elapsed();
        let added = bytes.len() - before;
        let top = read(&bytes, 0, bytes.len());
        let segment = &top[1];
        let cues = segment.one(CUES);
        let last = segment.all(CLUSTER).last().unwrap().body.len();
        assert_eq!(cues.all(CUE_POINT).len(), 3_600);
        assert!(
            added <= last + cues.body.len() + 16,
            "added {added} bytes for a {last}-byte Cluster and {}-byte Cues",
            cues.body.len()
        );
        assert!(took < std::time::Duration::from_millis(500), "{took:?}");
    }

    /// Cut off at every byte, a file is finished from the whole Clusters
    /// before the cut, says what plays, and a second recovery writes
    /// nothing; a file cut before its first whole Cluster holds no audio
    /// and is not touched.
    #[test]
    fn a_file_cut_off_at_any_byte_is_finished_from_its_whole_clusters_once() {
        let bytes = cut_off(181);
        let head = cut_off(0).len();
        let clusters: Vec<usize> = read(&bytes, head, bytes.len())
            .iter()
            .map(|cluster| cluster.start)
            .chain([bytes.len()])
            .collect();
        assert_eq!(clusters.len(), 4, "three whole Clusters");
        for cut in 0..=bytes.len() {
            let (found, after) = recovered(&bytes[..cut]);
            let whole = clusters[1..].iter().filter(|end| **end <= cut).count();
            if whole == 0 {
                assert_eq!(found, CutOff::Empty, "cut at {cut}");
                assert_eq!(after, &bytes[..cut], "cut at {cut}");
                continue;
            }
            let played = whole as u64 * 50 * FRAME_48K - PRE_SKIP;
            assert_eq!(found, CutOff::Recovered { played }, "cut at {cut}");
            // The Clusters are as written; only the head states more.
            assert_eq!(&after[head..clusters[whole]], &bytes[head..clusters[whole]]);
            assert_eq!(
                recovered(&after),
                (CutOff::Finished { played }, after.clone()),
                "cut at {cut}"
            );
            let top = read(&after, 0, after.len());
            assert_eq!(top[1].all(CLUSTER).len(), whole);
            assert_eq!(top[1].one(CUES).all(CUE_POINT).len(), whole);
        }
    }

    /// Stop can be cut off at any byte it writes: the file is finished
    /// again to the same length, its last packet still trimmed.
    #[test]
    fn a_stop_cut_off_while_it_finishes_is_finished_again_to_its_exact_length() {
        let played = 120 * FRAME_48K - PRE_SKIP - 700;
        let before = cut_off(120).len();
        let bytes = finished(120, played);
        // A cut anywhere in what Stop appended, and one after it appended
        // everything and wrote all but the size.
        let mut size_unknown = bytes.clone();
        let size_at = read(&bytes, 0, bytes.len())[1].start + 4;
        size_unknown[size_at..size_at + 8].copy_from_slice(&UNKNOWN_SIZE);
        let last_end = element(&bytes, before, bytes.len()).unwrap().end;
        for cut in (before..bytes.len())
            .map(|cut| bytes[..cut].to_vec())
            .chain([size_unknown])
        {
            let (found, after) = recovered(&cut);
            let whole_last = cut.len() >= last_end;
            let expected = if whole_last {
                played
            } else {
                100 * FRAME_48K - PRE_SKIP
            };
            assert_eq!(
                found,
                CutOff::Recovered { played: expected },
                "{}",
                cut.len()
            );
            assert_eq!(recovered(&after).0, CutOff::Finished { played: expected });
        }
    }

    /// A disk that fills mid-recording refuses the Cluster that does not
    /// fit, says so, and leaves the Clusters before it; finishing what was
    /// written waits for room, and loses nothing more while it waits.
    #[test]
    fn a_full_disk_keeps_the_whole_clusters_and_they_finish_once_there_is_room() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a.webm");
        let room = (cut_off(151).len() + 40) as u64;
        let mut webm = LiveWebm::new(
            FullDisk {
                file: File::create(&path).unwrap(),
                room,
            },
            PRE_SKIP as u16,
            16_000,
        )
        .unwrap();
        let mut refused = None;
        for index in 0..400u64 {
            if let Err(error) = webm.push(&[0xF8, index as u8, (index >> 8) as u8]) {
                refused = Some((index, error));
                break;
            }
        }
        let (index, error) = refused.expect("the disk filled");
        assert_eq!(index, 200, "the fourth Cluster did not fit");
        assert_eq!(error.kind(), io::ErrorKind::StorageFull);
        assert!(error.to_string().contains("No space left"), "{error}");
        drop(webm);
        let three = std::fs::read(&path).unwrap();
        assert_eq!(three, cut_off(151), "three whole Clusters, nothing torn");

        // Still full: nothing more is lost, and nothing is finished.
        let mut full = FullDisk {
            file: File::options().write(true).open(&path).unwrap(),
            room: three.len() as u64 + 8,
        };
        assert!(finish_cut_off_in(&three, &mut full).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), three);

        let played = 150 * FRAME_48K - PRE_SKIP;
        assert_eq!(finish_cut_off(&path).unwrap(), CutOff::Recovered { played });
        assert_eq!(finish_cut_off(&path).unwrap(), CutOff::Finished { played });
    }

    #[test]
    fn a_file_that_is_not_a_recording_holds_no_audio() {
        for bytes in [
            &b""[..],
            &b"not audio at all"[..],
            &[0x1A, 0x45, 0xDF, 0xA3, 0x9F][..],
        ] {
            assert_eq!(recovered(bytes), (CutOff::Empty, bytes.to_vec()));
        }
    }
}
