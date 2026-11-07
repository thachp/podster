#![allow(clippy::indexing_slicing)]
//! What an upload keeps as a file streams past.
use podster_core::files::{
    classify, fits_room_quota, ContentKind, FileEnds, FileSample, ROOM_QUOTA_BYTES,
    SAMPLE_HEAD_BYTES, SAMPLE_TAIL_BYTES,
};

#[test]
fn keeps_only_the_ends_however_the_file_is_cut() {
    let file: Vec<u8> = (0..5_000_000u32).map(|n| (n % 251) as u8).collect();
    for size in [1, 4096, 65_536, 1_000_003] {
        let mut ends = FileEnds::default();
        for chunk in file.chunks(size) {
            ends.add(chunk);
            assert!(ends.tail().len() <= SAMPLE_TAIL_BYTES);
        }
        assert_eq!(ends.head(), &file[..SAMPLE_HEAD_BYTES]);
        assert_eq!(ends.tail(), &file[file.len() - SAMPLE_TAIL_BYTES..]);
    }
}

#[test]
fn a_short_file_is_its_own_head_and_tail() {
    let mut ends = FileEnds::default();
    ends.add(b"hello ");
    ends.add(b"there");
    assert_eq!(ends.head(), b"hello there");
    assert_eq!(ends.tail(), b"hello there");
}

#[test]
fn what_it_keeps_is_a_sample_the_rules_accept() {
    let file = vec![b'a'; SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES + 17];
    let mut ends = FileEnds::default();
    for chunk in file.chunks(4096) {
        ends.add(chunk);
    }
    let sample = FileSample {
        head: ends.head(),
        tail: ends.tail(),
        total_size: file.len() as u64,
    };
    assert_eq!(classify(&sample), Ok(ContentKind::Text));
}

#[test]
fn its_debug_shows_no_bytes() {
    let mut ends = FileEnds::default();
    ends.add(b"secret");
    assert!(!format!("{ends:?}").contains("secret"));
}

#[test]
fn a_file_fits_up_to_the_quota_and_no_further() {
    assert!(fits_room_quota(ROOM_QUOTA_BYTES - 1, 1));
    assert!(!fits_room_quota(ROOM_QUOTA_BYTES, 1));
    assert!(!fits_room_quota(u64::MAX, 1));
}
