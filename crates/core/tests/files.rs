#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use podster_core::files::*;
use FileRefusal as R;
use ObjectState::*;
use ScanOutcome::*;

const HASH: &str = "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34";

// ---- limits ----

fn request(size: u64, room_used: u64) -> UploadRequest<'static> {
    UploadRequest {
        name: "report.pdf",
        size,
        room_used,
        room_archived: false,
    }
}

#[test]
fn a_file_can_be_exactly_the_limit_and_no_larger() {
    assert_eq!(
        check_upload(request(100_000_000, 0)).unwrap().size,
        100_000_000
    );
    assert_eq!(
        check_upload(request(100_000_001, 0)).unwrap_err(),
        R::TooLarge
    );
    assert_eq!(check_upload(request(u64::MAX, 0)).unwrap_err(), R::TooLarge);
}

#[test]
fn a_room_can_fill_exactly_and_no_further() {
    assert!(check_upload(request(1_000, 4_999_999_000)).is_ok());
    assert_eq!(
        check_upload(request(1_001, 4_999_999_000)).unwrap_err(),
        R::QuotaExceeded
    );
    assert_eq!(
        check_upload(request(1, 5_000_000_000)).unwrap_err(),
        R::QuotaExceeded
    );
}

#[test]
fn quota_arithmetic_cannot_wrap_around() {
    assert_eq!(
        check_upload(request(10, u64::MAX - 5)).unwrap_err(),
        R::QuotaExceeded
    );
}

#[test]
fn an_archived_room_takes_no_new_uploads() {
    let archived = UploadRequest {
        room_archived: true,
        ..request(10, 0)
    };
    assert_eq!(check_upload(archived).unwrap_err(), R::RoomArchived);
}

#[test]
fn an_empty_file_is_refused_at_both_ends() {
    assert_eq!(check_upload(request(0, 0)).unwrap_err(), R::NotOnList);
    let sample = FileSample {
        head: b"",
        tail: b"",
        total_size: 0,
    };
    assert_eq!(classify(&sample).unwrap_err(), R::NotOnList);
}

// ---- hostile names ----

fn clean(raw: &str) -> String {
    clean_file_name(raw).unwrap().as_str().to_string()
}

#[test]
fn path_parts_are_dropped() {
    for (raw, want) in [
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32\\evil.txt", "evil.txt"),
        ("C:\\Users\\me\\report.pdf", "report.pdf"),
        ("/absolute/path/report.pdf", "report.pdf"),
        ("dir/report.pdf/", "report.pdf"),
        ("a∕b⁄c／d＼report.pdf", "report.pdf"),
        ("..\u{200B}/..\u{200B}/report.pdf", "report.pdf"),
        ("..\u{202E}\\report.pdf", "report.pdf"),
    ] {
        assert_eq!(clean(raw), want, "{raw:?}");
    }
}

#[test]
fn names_that_are_only_a_path_or_nothing_are_refused() {
    for raw in [
        "",
        " ",
        ".",
        "..",
        "...",
        "../..",
        "/",
        "\\",
        "foo/..",
        "foo/ .. ",
        "\u{202E}",
        "\u{200B}\u{200B}",
        "\n\t",
        "...   ...",
        "-",
        "~",
        "--- ~",
    ] {
        assert_eq!(clean_file_name(raw).unwrap_err(), R::BadName, "{raw:?}");
    }
}

#[test]
fn control_characters_are_removed() {
    for (raw, want) in [
        ("report\0.pdf", "report.pdf"),
        ("report\r\nSet-Cookie: x.pdf", "reportSet-Cookie_ x.pdf"),
        ("\x1b[31mred\x1b[0m.txt", "[31mred[0m.txt"),
        ("del\x7f.txt", "del.txt"),
        ("c1\u{0085}\u{009B}.txt", "c1.txt"),
    ] {
        assert_eq!(clean(raw), want, "{raw:?}");
    }
}

#[test]
fn bidi_and_invisible_characters_are_removed() {
    // Reads as "annexe.pdf" on screen while really ending in .exe, until the override goes.
    assert_eq!(clean("anne\u{202E}fdp.exe"), "annefdp.exe");
    for mark in [
        '\u{200E}',
        '\u{200F}',
        '\u{061C}',
        '\u{202A}',
        '\u{202B}',
        '\u{202C}',
        '\u{202D}',
        '\u{2066}',
        '\u{2067}',
        '\u{2068}',
        '\u{2069}',
        '\u{200B}',
        '\u{200D}',
        '\u{2060}',
        '\u{FEFF}',
        '\u{00AD}',
        '\u{3164}',
        '\u{E0041}',
        '\u{FE0F}',
        '\u{E000}',
        '\u{2028}',
        '\u{2029}',
    ] {
        assert_eq!(
            clean(&format!("re{mark}port.pdf")),
            "report.pdf",
            "U+{:04X}",
            mark as u32
        );
    }
}

#[test]
fn characters_a_file_system_or_shell_treats_specially_are_replaced() {
    for (raw, want) in [
        ("a<b>c:d\"e|f?g*h.txt", "a_b_c_d_e_f_g_h.txt"),
        ("evil.txt:hidden", "evil.txt_hidden"),
        ("-rf.txt", "rf.txt"),
        ("~root.txt", "root.txt"),
        (".bashrc", "bashrc"),
        ("report.pdf. . ", "report.pdf"),
        (
            "  lots \u{00A0}\u{3000} of   space.txt  ",
            "lots of space.txt",
        ),
        ("..%2f..%2fetc%2fpasswd", "_2f.._2fetc_2fpasswd"),
        ("100% done.txt", "100% done.txt"),
        ("%zz.txt", "%zz.txt"),
    ] {
        assert_eq!(clean(raw), want, "{raw:?}");
    }
}

#[test]
fn reserved_device_names_are_defused_with_any_case_or_extension() {
    for (raw, want) in [
        ("CON", "_CON"),
        ("con.txt", "_con.txt"),
        ("Prn.tar.gz", "_Prn.tar.gz"),
        ("aux", "_aux"),
        ("NUL.", "_NUL"),
        ("com1.txt", "_com1.txt"),
        ("LPT9", "_LPT9"),
        ("com¹.txt", "_com¹.txt"),
        ("COM².txt", "_COM².txt"),
        ("LPT³", "_LPT³"),
        ("conin$", "_conin$"),
        ("con .txt", "_con .txt"),
        ("con\u{200B}.txt", "_con.txt"),
    ] {
        assert_eq!(clean(raw), want, "{raw:?}");
    }
    for fine in [
        "console.txt",
        "com10.txt",
        "lpt.txt",
        "nullable.rs",
        "prn2.txt",
        "a.con",
    ] {
        assert_eq!(clean(fine), fine);
    }
}

#[test]
fn long_names_keep_their_extension_and_fit() {
    let long = format!("{}.pdf", "a".repeat(500));
    let short = clean(&long);
    assert_eq!(short.len(), MAX_FILE_NAME_BYTES);
    assert!(short.ends_with(".pdf"));

    // A plain cut here would leave the name ending in .exe.
    let hidden = format!("{}.exe.txt", "a".repeat(MAX_FILE_NAME_BYTES - 4));
    assert!(clean(&hidden).ends_with(".txt"));
}

#[test]
fn long_names_are_cut_on_a_character_boundary() {
    // The odd byte puts the cut inside a two-byte character.
    let long = format!("a{}.txt", "é".repeat(300));
    let short = clean(&long);
    assert!(short.len() <= MAX_FILE_NAME_BYTES);
    assert!(
        short.len() >= MAX_FILE_NAME_BYTES - 1,
        "kept as much as fits"
    );
    assert!(short.starts_with("aé") && short.ends_with(".txt"));
}

#[test]
fn absurdly_long_names_are_refused_before_any_work() {
    let absurd = "a".repeat(MAX_RAW_FILE_NAME_BYTES + 1);
    assert_eq!(clean_file_name(&absurd).unwrap_err(), R::BadName);
    assert!(clean_file_name(&"a".repeat(MAX_RAW_FILE_NAME_BYTES)).is_ok());
}

#[test]
fn ordinary_names_survive() {
    for name in [
        "report.pdf",
        "Q3 plan (final).docx",
        "café menu.txt",
        "報告書.pdf",
        "don't panic.md",
        "a.tar.gz",
        "Makefile",
    ] {
        assert_eq!(clean(name), name);
    }
}

#[test]
fn cleaning_twice_changes_nothing() {
    let long_dotted = format!("{}.{}", "x ".repeat(300), "y".repeat(40));
    let spaced_cut = format!("{} b.txt", "a".repeat(MAX_FILE_NAME_BYTES - 5));
    for raw in [
        "../../etc/passwd",
        "con.txt",
        "anne\u{202E}fdp.exe",
        ". .con",
        "-.-con",
        "..%2f%2f",
        "%252f",
        "a%%2f",
        " . report .",
        long_dotted.as_str(),
        spaced_cut.as_str(),
    ] {
        let once = clean(raw);
        assert_eq!(clean(&once), once, "{raw:?}");
    }
}

#[test]
fn debug_output_never_shows_a_raw_name_or_file_bytes() {
    const SECRET_NAME: &str = "secret-plan.pdf";
    let asked = UploadRequest {
        name: SECRET_NAME,
        ..request(1, 0)
    };
    let shown = format!("{asked:?}");
    assert!(!shown.contains("secret"), "{shown}");
    assert!(shown.contains("name_bytes: 15"), "{shown}");

    let file = whole(b"secret bytes");
    let shown = format!("{:?}", file.sample());
    assert!(!shown.contains('['), "{shown}");
    assert!(shown.contains("head_bytes: 12"), "{shown}");

    let announced = "secret-announced-hash";
    let received = "secret-received-hash";
    let arrived = Arrival {
        announced_sha256: announced,
        received_sha256: received,
        ..arrival(&file)
    };
    let shown = format!("{arrived:?}");
    assert!(!shown.contains('['), "{shown}");
    assert!(!shown.contains("secret"), "{shown}");
    assert!(shown.contains("received_size: 12"), "{shown}");
}

#[test]
fn debug_output_never_shows_a_name() {
    let accepted = check_upload(request(1, 0)).unwrap();
    let shown = format!("{accepted:?}");
    assert!(!shown.contains("report"), "{shown}");
    assert!(shown.contains("size"));
}

// ---- names that would run when opened ----

#[test]
fn a_name_that_runs_is_refused_whatever_the_content() {
    for name in [
        "setup.exe",
        "SETUP.EXE",
        "setup.exe.",
        "setup.exe   ",
        "setup.exe\u{200B}",
        "setup.e\u{200D}xe",
        "report.pdf.exe",
        "a.txt:b.exe",
        "installer.msi",
        "app.dmg",
        "app.apk",
        "link.lnk",
        "tool.jar",
        "pack.deb",
        "x.hta",
        "x.scr",
    ] {
        let asked = UploadRequest {
            name,
            ..request(10, 0)
        };
        assert_eq!(check_upload(asked).unwrap_err(), R::Executable, "{name:?}");
    }
}

#[test]
fn the_extensions_added_by_decision_91_are_refused() {
    for ext in [
        "cmd",
        "vbs",
        "msc",
        "inf",
        "url",
        "jnlp",
        "application",
        "bat",
        "ps1",
        "sh",
        "js",
    ] {
        for name in [
            format!("run.{ext}"),
            format!("RUN.{}", ext.to_uppercase()),
            format!("report.pdf.{ext}"),
        ] {
            let asked = UploadRequest {
                name: &name,
                ..request(10, 0)
            };
            assert_eq!(check_upload(asked).unwrap_err(), R::Executable, "{name:?}");
        }
    }
}

#[test]
fn a_name_that_runs_is_refused_however_its_dot_or_letters_are_written() {
    for name in [
        "setup\u{FF0E}exe",               // full-width dot
        "setup.\u{FF45}\u{FF58}\u{FF45}", // full-width letters
        "\u{FF33}\u{FF25}\u{FF34}\u{FF35}\u{FF30}\u{FF0E}\u{FF25}\u{FF38}\u{FF25}", // all of it, in capitals
        "setup\u{FF0E}exe\u{FF0E}", // and a trailing one, which Windows drops
        "setup\u{3002}exe",         // ideographic full stop
        "setup\u{FF61}exe",         // half-width ideographic full stop
        "setup\u{FE52}exe",         // small full stop
        "setup\u{2024}exe",         // one dot leader
        "run\u{FF0E}sh",
        "run\u{FF0E}js",
    ] {
        let asked = UploadRequest {
            name,
            ..request(10, 0)
        };
        assert_eq!(check_upload(asked).unwrap_err(), R::Executable, "{name:?}");
    }
}

#[test]
fn shortening_cannot_uncover_a_name_with_a_full_width_dot() {
    let name = format!(
        "{}\u{FF0E}exe\u{FF0E}{}",
        "a".repeat(MAX_FILE_NAME_BYTES - 6),
        "y".repeat(30)
    );
    let asked = UploadRequest {
        name: &name,
        ..request(10, 0)
    };
    assert_eq!(check_upload(asked).unwrap_err(), R::Executable);
}

#[test]
fn full_width_characters_stay_in_a_name_that_doesnt_run() {
    let name = "\u{5831}\u{544A}\u{FF0E}\u{FF50}\u{FF44}\u{FF46}";
    let asked = UploadRequest {
        name,
        ..request(10, 0)
    };
    assert_eq!(check_upload(asked).unwrap().name.as_str(), name);
}

#[test]
fn names_near_the_refused_extensions_are_allowed() {
    for name in [
        "scripts.py",
        "notes.json",
        "view.jsx",
        "page.shtml",
        "links.urls",
        "app.applications",
        "bat",
        "js",
        "sh.txt",
        "run.js.txt",
    ] {
        let asked = UploadRequest {
            name,
            ..request(1, 0)
        };
        assert!(check_upload(asked).is_ok(), "{name:?}");
    }
}

#[test]
fn shortening_cannot_uncover_a_name_that_runs() {
    let extension_too_long_to_keep = "y".repeat(30);
    let name = format!(
        "{}.exe.{extension_too_long_to_keep}",
        "a".repeat(MAX_FILE_NAME_BYTES - 4)
    );
    let asked = UploadRequest {
        name: &name,
        ..request(10, 0)
    };
    assert_eq!(check_upload(asked).unwrap_err(), R::Executable);
}

#[test]
fn a_name_only_refuses_and_a_harmless_name_lets_nothing_in() {
    let exe = Whole(windows_program());
    assert_eq!(classify(&exe.sample()).unwrap_err(), R::Executable);
    assert!(
        check_upload(request(exe.0.len() as u64, 0)).is_ok(),
        "the name is fine"
    );
    assert!(check_upload(UploadRequest {
        name: "scripts.py",
        ..request(1, 0)
    })
    .is_ok());
    assert!(check_upload(UploadRequest {
        name: "exe",
        ..request(1, 0)
    })
    .is_ok());
}

// ---- spoofed content ----

/// A file whose samples are cut the way `FileSample` says.
struct Whole(Vec<u8>);

impl Whole {
    fn sample(&self) -> FileSample<'_> {
        let head = self.0.len().min(SAMPLE_HEAD_BYTES);
        let tail = self.0.len().min(SAMPLE_TAIL_BYTES);
        FileSample {
            head: &self.0[..head],
            tail: &self.0[self.0.len() - tail..],
            total_size: self.0.len() as u64,
        }
    }
}

fn whole(bytes: &[u8]) -> Whole {
    Whole(bytes.to_vec())
}

fn kind_of(bytes: &[u8]) -> Result<ContentKind, R> {
    classify(&whole(bytes).sample())
}

#[test]
fn executables_are_refused_by_their_bytes() {
    let signatures: [&[u8]; 15] = [
        b"\x7fELF",
        b"\xFE\xED\xFA\xCE",
        b"\xFE\xED\xFA\xCF",
        b"\xCE\xFA\xED\xFE",
        b"\xCF\xFA\xED\xFE",
        b"\xCA\xFE\xBA\xBE",
        b"\0asm",
        b"dex\n035",
        b"\xED\xAB\xEE\xDB",
        b"!<arch>\ndebian-binary",
        b"MSCF",
        b"ISc(",
        b"xar!",
        b"Cr24",
        b"L\0\0\0\x01\x14\x02\0\0\0\0\0\xC0\0\0\0\0\0\0F",
    ];
    for signature in signatures {
        let mut file = signature.to_vec();
        file.extend_from_slice(&[0_u8; 64]);
        assert_eq!(kind_of(&file).unwrap_err(), R::Executable, "{signature:?}");
        // Printable, so only the signature is refusing it.
        let mut printable = signature.to_vec();
        printable.extend_from_slice(b" plain words");
        assert_eq!(
            kind_of(&printable).unwrap_err(),
            R::Executable,
            "{signature:?}"
        );
    }
}

/// `MZ`, with the place of its `PE` header at 0x3C and the header there.
fn windows_program() -> Vec<u8> {
    let mut program = b"MZ\x90\0".to_vec();
    program.resize(0x3C, 0);
    program.extend_from_slice(&0x80_u32.to_le_bytes());
    program.resize(0x80, 0);
    program.extend_from_slice(b"PE\0\0");
    program.extend_from_slice(&[0; 64]);
    program
}

/// `MZ`, pointing at a `PE` header at `at`, in a file of `len` zeroes otherwise.
fn program_with_header_at(at: usize, len: usize) -> Vec<u8> {
    let mut program = vec![0_u8; len];
    program[..2].copy_from_slice(b"MZ");
    program[0x3C..0x40].copy_from_slice(&(at as u32).to_le_bytes());
    program[at..at + 4].copy_from_slice(b"PE\0\0");
    program
}

#[test]
fn a_windows_program_is_refused_by_its_header() {
    assert_eq!(kind_of(&windows_program()).unwrap_err(), R::Executable);
    // Near the end of a long file, so only the tail sample holds it.
    let len = SAMPLE_HEAD_BYTES + SAMPLE_TAIL_BYTES + 5000;
    let in_tail = program_with_header_at(len - 100, len);
    assert_eq!(kind_of(&in_tail).unwrap_err(), R::Executable);
}

#[test]
fn only_a_file_starting_mz_can_be_a_windows_program() {
    let mut image = windows_program();
    image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    assert_eq!(kind_of(&image), Ok(ContentKind::Png));
}

#[test]
fn text_starting_with_mz_is_still_text() {
    assert_eq!(kind_of(b"MZ report\n"), Ok(ContentKind::Text));
    let mut mz_long = b"MZ".to_vec();
    mz_long.resize(200, b'a');
    assert_eq!(kind_of(&mz_long), Ok(ContentKind::Text));
}

#[test]
fn a_program_whose_header_is_out_of_reach_fails_closed() {
    // Past the head and before the tail: the signature can't be seen, and the file still isn't accepted.
    let at = SAMPLE_HEAD_BYTES + 1000;
    let unseen = program_with_header_at(at, SAMPLE_HEAD_BYTES + SAMPLE_TAIL_BYTES + 5000);
    assert_eq!(kind_of(&unseen).unwrap_err(), R::NotOnList);

    // A pointer past the end of the file, and a pointer to something else.
    let mut past_the_end = b"MZ\x90\0".to_vec();
    past_the_end.resize(0x3C, 0);
    past_the_end.extend_from_slice(&0x0100_0000_u32.to_le_bytes());
    assert_eq!(kind_of(&past_the_end).unwrap_err(), R::NotOnList);

    let mut wrong_header = windows_program();
    wrong_header[0x80] = b'X';
    assert_eq!(kind_of(&wrong_header).unwrap_err(), R::NotOnList);

    // Too short to hold a pointer, and not text.
    assert_eq!(kind_of(b"MZ\x90\0\x03\0\0\0").unwrap_err(), R::NotOnList);
}

#[test]
fn a_dos_program_in_printable_characters_reads_as_text() {
    // A documented limit, pinned so it can't be mistaken for a check. Its name can't end .exe or .com.
    assert_eq!(kind_of(b"MZ!printable!program\n"), Ok(ContentKind::Text));
}

#[test]
fn a_password_protected_open_document_file_passes_as_a_zip() {
    // A documented limit, pinned so it can't be mistaken for a check: its zip flags are 0, and only the manifest says so.
    let file = zip(&[
        entry("mimetype"),
        entry("META-INF/manifest.xml"),
        entry("content.xml"),
    ]);
    assert_eq!(kind_of(&file), Ok(ContentKind::Zip));
}

#[test]
fn a_disk_image_is_refused_by_its_trailer() {
    let mut dmg = vec![b'a'; 2048];
    dmg.extend_from_slice(b"koly");
    dmg.extend_from_slice(&[b'a'; 508]);
    assert_eq!(kind_of(&dmg).unwrap_err(), R::Executable);
}

#[test]
fn a_self_extractor_is_an_executable_not_a_zip() {
    let mut sfx = windows_program();
    sfx.extend_from_slice(&zip(&[entry("a.txt")]));
    assert_eq!(kind_of(&sfx).unwrap_err(), R::Executable);

    // Without the header it's no program, and a zip on the end of unknown bytes still isn't accepted.
    let mut stub = b"MZ\x90\0".to_vec();
    stub.extend_from_slice(&zip(&[entry("a.txt")]));
    assert_eq!(kind_of(&stub).unwrap_err(), R::CannotInspect);
}

#[test]
fn unknown_binary_is_refused_by_default() {
    for bytes in [
        &b"\x01\x02\x03\x04\x05binary"[..],
        b"Rar!\x1a\x07\x00",
        b"7z\xBC\xAF\x27\x1C",
        b"\x1f\x8b\x08\x00",
        b"plain text with a NUL\0inside",
        b"\xC3\x28 bad utf-8",
        b"ID3\x03\0\0\0\0\0\0",
        b"\xFF\xFB\x90\x00",
    ] {
        assert_eq!(kind_of(bytes).unwrap_err(), R::NotOnList, "{bytes:?}");
    }
}

#[test]
fn allowed_formats_are_recognized_from_their_bytes() {
    let mut bmp = b"BM".to_vec();
    bmp.extend_from_slice(&30_u32.to_le_bytes());
    bmp.resize(30, 0);
    let cases: [(&[u8], ContentKind); 19] = [
        (b"\x89PNG\r\n\x1a\n\0\0", ContentKind::Png),
        (b"\xFF\xD8\xFF\xE0\0\x10", ContentKind::Jpeg),
        (b"GIF89a\x01\0", ContentKind::Gif),
        (b"GIF87a\x01\0", ContentKind::Gif),
        (b"RIFF\0\0\0\0WEBPVP8 ", ContentKind::Webp),
        (b"II*\0\x08\0", ContentKind::Tiff),
        (b"MM\0*\0\0", ContentKind::Tiff),
        (&bmp, ContentKind::Bmp),
        (b"\0\0\0\x18ftypheic\0\0", ContentKind::Heif),
        (b"\0\0\0\x18ftypavif\0\0", ContentKind::Heif),
        (b"\0\0\0\x18ftypisom\0\0", ContentKind::Mp4),
        (b"\0\0\0\x18ftypM4V \0\0", ContentKind::Mp4),
        (b"\0\0\0\x14ftypqt  \0\0", ContentKind::QuickTime),
        (b"\x1A\x45\xDF\xA3\x01", ContentKind::Matroska),
        (b"RIFF\0\0\0\0AVI LIST", ContentKind::Avi),
        (b"\0\0\x01\xBA\x44", ContentKind::Mpeg),
        (b"{\\rtf1\\ansi hi}", ContentKind::Rtf),
        (b"%PDF-1.7\nstartxref\n0\n%%EOF", ContentKind::Pdf),
        (b"fn main() {}\n", ContentKind::Text),
    ];
    for (bytes, want) in cases {
        assert_eq!(kind_of(bytes), Ok(want), "{bytes:?}");
    }
}

#[test]
fn audio_is_not_on_the_list() {
    for bytes in [
        &b"RIFF\0\0\0\0WAVEfmt "[..],
        b"\0\0\0\x18ftypM4A \0\0",
        b"\0\0\0\x18ftypM4B \0\0",
    ] {
        assert_eq!(kind_of(bytes).unwrap_err(), R::NotOnList, "{bytes:?}");
    }
}

#[test]
fn text_forms_stay_plain_so_nothing_renders_them() {
    for bytes in [
        &b"<html><script>alert(1)</script></html>"[..],
        b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
        b"#!/bin/sh\nrm -rf /\n",
        b"\xEF\xBB\xBFwith a byte order mark\r\n\ttabbed",
    ] {
        let kind = kind_of(bytes).unwrap();
        assert_eq!(kind, ContentKind::Text, "{bytes:?}");
        assert_eq!(kind.media_type(), "text/plain; charset=utf-8");
    }
}

#[test]
fn text_starting_like_a_bitmap_is_still_text() {
    assert_eq!(kind_of(b"BMW sales figures\n"), Ok(ContentKind::Text));
}

#[test]
fn a_sample_of_the_wrong_length_is_refused() {
    let file = vec![b'a'; 100];
    for sample in [
        FileSample {
            head: &file[..10],
            tail: &file,
            total_size: 100,
        },
        FileSample {
            head: &file,
            tail: &file[..10],
            total_size: 100,
        },
        FileSample {
            head: &file,
            tail: &file,
            total_size: 101,
        },
        FileSample {
            head: &file,
            tail: &file,
            total_size: 99,
        },
        FileSample {
            head: b"",
            tail: b"",
            total_size: 100,
        },
    ] {
        assert_eq!(classify(&sample).unwrap_err(), R::CannotInspect);
    }
}

#[test]
fn a_long_text_file_cut_midway_through_characters_is_still_text() {
    // Multi-byte characters, shifted by one so the head and the tail each land inside one.
    let mut file = b"ab".to_vec();
    while file.len() < SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES {
        file.extend_from_slice("日本語".as_bytes());
    }
    file.extend_from_slice(b"ab");
    assert_eq!(kind_of(&file), Ok(ContentKind::Text));
}

#[test]
fn binary_at_either_end_of_a_long_text_file_refuses_it() {
    let mut late = vec![b'a'; SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES + 10];
    *late.last_mut().unwrap() = 0;
    assert_eq!(kind_of(&late).unwrap_err(), R::NotOnList);

    let mut early = vec![b'a'; SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES + 10];
    early[100] = 0;
    assert_eq!(kind_of(&early).unwrap_err(), R::NotOnList);

    // A character cut off at the very end of a file is bad UTF-8, not a cut in the sample.
    let mut cut_off = vec![b'a'; 100];
    cut_off.push(0xE6);
    assert_eq!(kind_of(&cut_off).unwrap_err(), R::NotOnList);

    let mut long_cut_off = vec![b'a'; SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES];
    long_cut_off.push(0xE6);
    assert_eq!(kind_of(&long_cut_off).unwrap_err(), R::NotOnList);
}

#[test]
fn what_the_middle_of_a_long_file_holds_goes_unread() {
    // A documented limit, pinned so it can't be mistaken for a check. The scanner is the next line.
    let mut file = vec![b'a'; SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES + 1000];
    file[SAMPLE_HEAD_BYTES + 10] = 0;
    assert_eq!(kind_of(&file), Ok(ContentKind::Text));
}

#[test]
fn a_zip_stuck_on_another_format_is_refused() {
    for start in [
        &b"\xFF\xD8\xFF\xE0jpeg"[..],
        b"GIF89a",
        b"plain text\n",
        b"%PDF-1.7\nstartxref\n",
    ] {
        let mut file = start.to_vec();
        file.extend_from_slice(&zip(&[entry("hidden.txt")]));
        assert_eq!(kind_of(&file).unwrap_err(), R::CannotInspect, "{start:?}");
    }
}

// ---- zips ----

struct Entry {
    name: String,
    central_flags: u16,
    local_flags: u16,
    method: u16,
}

fn entry(name: &str) -> Entry {
    Entry {
        name: name.to_string(),
        central_flags: 0,
        local_flags: 0,
        method: 0,
    }
}

fn zip(entries: &[Entry]) -> Vec<u8> {
    zip_with_comment(entries, b"")
}

fn zip_with_comment(entries: &[Entry], comment: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for e in entries {
        let offset = out.len() as u32;
        let name = e.name.as_bytes();
        out.extend_from_slice(b"PK\x03\x04\x14\0");
        out.extend_from_slice(&e.local_flags.to_le_bytes());
        out.extend_from_slice(&e.method.to_le_bytes());
        out.extend_from_slice(&[0; 16]);
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0; 2]);
        out.extend_from_slice(name);
        out.extend_from_slice(b"data");

        directory.extend_from_slice(b"PK\x01\x02\x14\0\x14\0");
        directory.extend_from_slice(&e.central_flags.to_le_bytes());
        directory.extend_from_slice(&e.method.to_le_bytes());
        directory.extend_from_slice(&[0; 16]);
        directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
        directory.extend_from_slice(&[0; 12]);
        directory.extend_from_slice(&offset.to_le_bytes());
        directory.extend_from_slice(name);
    }
    let start = out.len() as u32;
    out.extend_from_slice(&directory);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(directory.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&(comment.len() as u16).to_le_bytes());
    out.extend_from_slice(comment);
    out
}

fn office(part: &str) -> Vec<Entry> {
    vec![entry("[Content_Types].xml"), entry(part)]
}

#[test]
fn zips_and_office_files_are_told_apart() {
    assert_eq!(
        kind_of(&zip(&[entry("a.txt"), entry("b/c.png")])),
        Ok(ContentKind::Zip)
    );
    assert_eq!(
        kind_of(&zip(&office("word/document.xml"))),
        Ok(ContentKind::Word)
    );
    assert_eq!(
        kind_of(&zip(&office("xl/workbook.xml"))),
        Ok(ContentKind::Spreadsheet)
    );
    assert_eq!(
        kind_of(&zip(&office("ppt/presentation.xml"))),
        Ok(ContentKind::Presentation)
    );
    // These folder names without Office's own file are only a zip.
    assert_eq!(
        kind_of(&zip(&[entry("word/document.xml")])),
        Ok(ContentKind::Zip)
    );
    let open_document = [
        entry("mimetype"),
        entry("META-INF/manifest.xml"),
        entry("content.xml"),
    ];
    assert_eq!(kind_of(&zip(&open_document)), Ok(ContentKind::Zip));
}

#[test]
fn a_zip_that_installs_or_runs_is_an_executable() {
    for name in [
        "META-INF/MANIFEST.MF",
        "meta-inf\\manifest.mf",
        "AndroidManifest.xml",
        "classes.dex",
        "AppxManifest.xml",
        "AppxMetadata/AppxBundleManifest.xml",
        "Payload/Thing.app/Thing",
    ] {
        let file = zip(&[entry("readme.txt"), entry(name)]);
        assert_eq!(kind_of(&file).unwrap_err(), R::Executable, "{name}");
    }
}

#[test]
fn entries_elsewhere_with_those_names_are_ordinary() {
    let file = zip(&[
        entry("src/main/AndroidManifest.xml"),
        entry("project/META-INF/MANIFEST.MF"),
        entry("Payload/notes.txt"),
    ]);
    assert_eq!(kind_of(&file), Ok(ContentKind::Zip));
}

#[test]
fn a_zip_with_any_encrypted_entry_is_refused() {
    let plain = || entry("plain.txt");
    let cases = [
        (
            "central bit 0",
            Entry {
                central_flags: 1,
                ..entry("s.txt")
            },
        ),
        (
            "central strong",
            Entry {
                central_flags: 0x40,
                ..entry("s.txt")
            },
        ),
        (
            "central masked",
            Entry {
                central_flags: 0x2000,
                ..entry("s.txt")
            },
        ),
        (
            "winzip aes",
            Entry {
                method: 99,
                ..entry("s.txt")
            },
        ),
        // The directory says plain, and the local header says otherwise.
        (
            "local only",
            Entry {
                local_flags: 1,
                ..entry("s.txt")
            },
        ),
    ];
    for (what, secret) in cases {
        let file = zip(&[plain(), plain(), secret]);
        assert_eq!(kind_of(&file).unwrap_err(), R::PasswordProtected, "{what}");
    }
}

#[test]
fn an_encrypted_first_entry_is_refused_from_the_head_alone() {
    // Its directory is unusable, so only the look at the file's start can give this answer.
    let mut file = zip(&[Entry {
        local_flags: 1,
        ..entry("s.txt")
    }]);
    file.truncate(file.len() - 22);
    assert_eq!(kind_of(&file).unwrap_err(), R::PasswordProtected);
}

#[test]
fn an_encrypted_office_file_in_a_zip_is_refused_too() {
    let file = zip(&[
        entry("[Content_Types].xml"),
        Entry {
            central_flags: 1,
            ..entry("word/document.xml")
        },
    ]);
    assert_eq!(kind_of(&file).unwrap_err(), R::PasswordProtected);
}

#[test]
fn a_zip_this_cannot_read_whole_is_refused() {
    let good = zip(&[entry("a.txt"), entry("b.txt")]);
    let end = good.len() - 22;

    let mut no_end_record = good.clone();
    no_end_record.truncate(end);
    assert_eq!(kind_of(&no_end_record).unwrap_err(), R::CannotInspect);

    let patched = |at: usize, bytes: &[u8]| {
        let mut file = good.clone();
        file[end + at..end + at + bytes.len()].copy_from_slice(bytes);
        file
    };
    let cases = [
        ("multi-disk", patched(4, &1_u16.to_le_bytes())),
        (
            "directory on another disk",
            patched(6, &1_u16.to_le_bytes()),
        ),
        ("fewer on this disk", patched(8, &1_u16.to_le_bytes())),
        ("hides an entry", patched(10, &1_u16.to_le_bytes())),
        (
            "claims an entry too many",
            patched(10, &3_u16.to_le_bytes()),
        ),
        ("zip64 count", {
            let mut counted = patched(8, &u16::MAX.to_le_bytes());
            counted[end + 10..end + 12].copy_from_slice(&u16::MAX.to_le_bytes());
            counted
        }),
        ("size that disagrees", patched(12, &1_u32.to_le_bytes())),
        ("zip64 size", patched(12, &u32::MAX.to_le_bytes())),
        ("zip64 offset", patched(16, &u32::MAX.to_le_bytes())),
        ("directory elsewhere", patched(16, &0_u32.to_le_bytes())),
        ("no entries", {
            let mut none = patched(8, &0_u16.to_le_bytes());
            none[end + 10..end + 12].copy_from_slice(&0_u16.to_le_bytes());
            none
        }),
    ];
    for (what, file) in cases {
        assert_eq!(kind_of(&file).unwrap_err(), R::CannotInspect, "{what}");
    }

    // Both agree on one entry, leaving the second unread in the directory.
    let mut short_count = good.clone();
    short_count[end + 8..end + 12].copy_from_slice(&[1, 0, 1, 0]);
    assert_eq!(kind_of(&short_count).unwrap_err(), R::CannotInspect);
}

#[test]
fn a_directory_saying_it_lists_nothing_is_refused() {
    // The file still holds entries, which this claim would hide.
    let hidden = zip(&[Entry {
        central_flags: 1,
        ..entry("s.txt")
    }]);
    let start = hidden.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    let mut file = hidden[..start].to_vec();
    file.extend_from_slice(b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0");
    file.extend_from_slice(&(start as u32).to_le_bytes());
    file.extend_from_slice(&[0; 2]);
    assert_eq!(kind_of(&file).unwrap_err(), R::CannotInspect);
}

#[test]
fn a_directory_entry_with_a_lying_length_is_refused() {
    let mut file = zip(&[entry("a.txt")]);
    let directory = file.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    file[directory + 28..directory + 30].copy_from_slice(&u16::MAX.to_le_bytes());
    assert_eq!(kind_of(&file).unwrap_err(), R::CannotInspect);
}

#[test]
fn a_directory_too_big_for_the_sample_is_refused() {
    let padding = "n".repeat(60_000);
    let entries: Vec<Entry> = (0..20).map(|i| entry(&format!("{i}{padding}"))).collect();
    assert_eq!(kind_of(&zip(&entries)).unwrap_err(), R::CannotInspect);
}

#[test]
fn a_fake_end_record_in_a_comment_is_ignored() {
    // A comment holding what looks like an empty zip's end record, whose own comment doesn't reach the file's end.
    let mut fake = b"PK\x05\x06".to_vec();
    fake.extend_from_slice(&[0; 16]);
    fake.extend_from_slice(&5000_u16.to_le_bytes());
    fake.extend_from_slice(b"pad");
    let secret = Entry {
        central_flags: 1,
        ..entry("s.txt")
    };
    let file = zip_with_comment(&[entry("a.txt"), secret], &fake);
    assert_eq!(kind_of(&file).unwrap_err(), R::PasswordProtected);
}

#[test]
fn an_ordinary_comment_is_fine() {
    assert_eq!(
        kind_of(&zip_with_comment(&[entry("a.txt")], b"made by me")),
        Ok(ContentKind::Zip)
    );
}

#[test]
fn a_long_zip_is_read_from_its_tail() {
    let entries = [
        entry("a.txt"),
        Entry {
            central_flags: 1,
            ..entry("s.txt")
        },
    ];
    let tiny = zip(&entries);
    // Grow the first entry's data so the directory sits far past the head sample.
    let padding = vec![b'x'; SAMPLE_TAIL_BYTES * 2];
    let mut file = tiny[..35].to_vec();
    file.extend_from_slice(&padding);
    file.extend_from_slice(&tiny[35..]);
    let end = file.len() - 22;
    let start =
        u32::from_le_bytes(file[end + 16..end + 20].try_into().unwrap()) + padding.len() as u32;
    file[end + 16..end + 20].copy_from_slice(&start.to_le_bytes());
    assert_eq!(kind_of(&file).unwrap_err(), R::PasswordProtected);
}

// ---- open rulings: macros and legacy Office ----

#[test]
fn macro_files_stay_refused_until_the_owner_rules() {
    for (what, file) in [
        (
            "word",
            zip(&[
                entry("[Content_Types].xml"),
                entry("word/document.xml"),
                entry("word/vbaProject.bin"),
            ]),
        ),
        (
            "excel",
            zip(&[entry("[Content_Types].xml"), entry("xl/vbaProject.bin")]),
        ),
        (
            "excel 4",
            zip(&[
                entry("[Content_Types].xml"),
                entry("xl/macrosheets/sheet1.xml"),
            ]),
        ),
        (
            "slides",
            zip(&[entry("[Content_Types].xml"), entry("ppt/vbaProject.bin")]),
        ),
        (
            "opendocument",
            zip(&[
                entry("mimetype"),
                entry("META-INF/manifest.xml"),
                entry("Basic/script-lc.xml"),
            ]),
        ),
    ] {
        assert_eq!(kind_of(&file).unwrap_err(), R::MacroEnabled, "{what}");
    }
}

#[test]
fn those_entry_names_in_a_plain_zip_are_only_files() {
    let file = zip(&[
        entry("backup/vbaProject.bin"),
        entry("Scripts/run.txt"),
        entry("Basic/a.txt"),
    ]);
    assert_eq!(kind_of(&file), Ok(ContentKind::Zip));
}

const COMPOUND: &[u8] = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1";

#[test]
fn legacy_office_and_installers_share_a_container_so_all_are_refused() {
    let mut legacy = COMPOUND.to_vec();
    legacy.extend_from_slice(&[0; 600]);
    assert_eq!(kind_of(&legacy).unwrap_err(), R::CannotInspect);
}

#[test]
fn a_password_protected_docx_is_named_as_that() {
    // Encrypted Office files aren't zips at all: they're this container, holding a stream with this UTF-16 name.
    let name: Vec<u8> = "EncryptedPackage"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut near_the_start = COMPOUND.to_vec();
    near_the_start.extend_from_slice(&name);
    near_the_start.extend_from_slice(&[0; 100]);
    assert_eq!(kind_of(&near_the_start).unwrap_err(), R::PasswordProtected);

    let mut near_the_end = COMPOUND.to_vec();
    near_the_end.resize(SAMPLE_HEAD_BYTES + 5000, 0);
    near_the_end.extend_from_slice(&name);
    assert_eq!(kind_of(&near_the_end).unwrap_err(), R::PasswordProtected);
}

// ---- PDFs ----

#[test]
fn a_password_protected_pdf_is_refused() {
    for file in [
        &b"%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%EOF"[..],
        b"%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt<</V 2>> >>\nstartxref\n0",
        // PDF lets a name spell any letter as #xx.
        b"%PDF-1.7\ntrailer << /Encr#79pt 5 0 R >>\nstartxref\n0",
        b"%PDF-1.7\ntrailer << /#45#6e#63#72#79#70#74 5 0 R >>\nstartxref\n0",
    ] {
        assert_eq!(
            kind_of(file).unwrap_err(),
            R::PasswordProtected,
            "{:?}",
            String::from_utf8_lossy(file)
        );
    }
}

#[test]
fn encryption_is_found_at_either_end_of_a_long_pdf() {
    let filler = vec![b' '; SAMPLE_TAIL_BYTES + SAMPLE_HEAD_BYTES];

    let mut linearized = b"%PDF-1.7\n<< /Encrypt 5 0 R >>\n".to_vec();
    linearized.extend_from_slice(&filler);
    linearized.extend_from_slice(b"startxref\n0");
    assert_eq!(kind_of(&linearized).unwrap_err(), R::PasswordProtected);

    let mut at_the_end = b"%PDF-1.7\n".to_vec();
    at_the_end.extend_from_slice(&filler);
    at_the_end.extend_from_slice(b"<< /Encrypt 5 0 R >>\nstartxref\n0");
    assert_eq!(kind_of(&at_the_end).unwrap_err(), R::PasswordProtected);
}

#[test]
fn a_pdf_padded_to_push_its_trailer_out_of_reach_is_refused() {
    let mut padded = b"%PDF-1.7\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n".to_vec();
    padded.extend_from_slice(&vec![b' '; SAMPLE_TAIL_BYTES + 10]);
    assert_eq!(kind_of(&padded).unwrap_err(), R::CannotInspect);
}

#[test]
fn similar_pdf_names_are_not_encryption() {
    for file in [
        &b"%PDF-1.7\n<< /Encr 1 /Type /Catalog /E#6e 2 >>\nstartxref\n0"[..],
        b"%PDF-1.7\n<< /Encr#zz 1 >>\nstartxref\n0",
    ] {
        assert_eq!(
            kind_of(file),
            Ok(ContentKind::Pdf),
            "{:?}",
            String::from_utf8_lossy(file)
        );
    }
}

// ---- states ----

fn arrival<'a>(file: &'a Whole) -> Arrival<'a> {
    Arrival {
        announced_size: file.0.len() as u64,
        announced_sha256: HASH,
        received_size: file.0.len() as u64,
        received_sha256: HASH,
        sample: file.sample(),
    }
}

#[test]
fn an_upload_that_arrives_whole_goes_to_scanning() {
    let file = whole(b"hello\n");
    assert_eq!(
        complete_upload(Uploading, &arrival(&file)),
        Ok(CompletedUpload {
            state: Scanning,
            kind: ContentKind::Text
        })
    );
}

#[test]
fn only_an_uploading_object_can_complete() {
    let file = whole(b"hello\n");
    for state in [Scanning, Ready, Blocked, Failed] {
        assert_eq!(
            complete_upload(state, &arrival(&file)).unwrap_err(),
            R::InvalidTransition,
            "{state:?}"
        );
    }
}

#[test]
fn what_arrived_has_to_be_what_was_announced() {
    let file = whole(b"hello\n");
    let other = HASH.replace('a', "b");
    let shouting = HASH.to_uppercase();
    let cases = [
        (
            "short",
            Arrival {
                received_size: 5,
                ..arrival(&file)
            },
        ),
        (
            "long",
            Arrival {
                received_size: 7,
                ..arrival(&file)
            },
        ),
        (
            "other announced",
            Arrival {
                announced_size: 7,
                ..arrival(&file)
            },
        ),
        (
            "other hash",
            Arrival {
                received_sha256: &other,
                ..arrival(&file)
            },
        ),
        (
            "empty hashes",
            Arrival {
                announced_sha256: "",
                received_sha256: "",
                ..arrival(&file)
            },
        ),
        (
            "not hashes",
            Arrival {
                announced_sha256: "x",
                received_sha256: "x",
                ..arrival(&file)
            },
        ),
        (
            "wrong form",
            Arrival {
                announced_sha256: &shouting,
                received_sha256: &shouting,
                ..arrival(&file)
            },
        ),
    ];
    for (what, arrived) in cases {
        assert_eq!(
            complete_upload(Uploading, &arrived).unwrap_err(),
            R::Mismatch,
            "{what}"
        );
    }
    let mut sampled_other = arrival(&file);
    sampled_other.sample.total_size = 7;
    assert_eq!(
        complete_upload(Uploading, &sampled_other).unwrap_err(),
        R::Mismatch
    );
}

#[test]
fn a_file_over_the_limit_cannot_complete_even_if_it_was_announced() {
    let big = Whole(vec![b'a'; 1]);
    let mut arrived = arrival(&big);
    arrived.announced_size = MAX_FILE_BYTES + 1;
    arrived.received_size = MAX_FILE_BYTES + 1;
    arrived.sample.total_size = MAX_FILE_BYTES + 1;
    assert_eq!(
        complete_upload(Uploading, &arrived).unwrap_err(),
        R::TooLarge
    );
}

#[test]
fn spoofed_content_never_reaches_the_scanner() {
    for (bytes, want) in [
        (windows_program(), R::Executable),
        (b"\x01\x02unknown".to_vec(), R::NotOnList),
    ] {
        let file = Whole(bytes);
        assert_eq!(
            complete_upload(Uploading, &arrival(&file)).unwrap_err(),
            want
        );
    }
    let secret = Whole(zip(&[Entry {
        central_flags: 1,
        ..entry("s.txt")
    }]));
    assert_eq!(
        complete_upload(Uploading, &arrival(&secret)).unwrap_err(),
        R::PasswordProtected
    );
}

const AT: i64 = 1_000_000_000;
const SOON: i64 = AT + 1_000;
const LAST_MOMENT: i64 = AT + SCAN_DEADLINE_MS - 1;
const AN_HOUR_LATER: i64 = AT + SCAN_DEADLINE_MS;

#[test]
fn a_scan_ends_in_ready_only_on_a_clean_report_in_time() {
    assert_eq!(record_scan(Scanning, NoKnownMalware, AT, SOON), Ok(Ready));
    assert_eq!(
        record_scan(Scanning, NoKnownMalware, AT, LAST_MOMENT),
        Ok(Ready)
    );
    assert_eq!(record_scan(Scanning, MalwareFound, AT, SOON), Ok(Blocked));
    assert_eq!(record_scan(Scanning, Unreadable, AT, SOON), Ok(Blocked));
}

#[test]
fn a_clean_report_after_the_hour_is_too_late() {
    assert_eq!(
        record_scan(Scanning, NoKnownMalware, AT, AN_HOUR_LATER),
        Ok(Failed)
    );
    assert_eq!(
        record_scan(Scanning, NoKnownMalware, i64::MIN, i64::MAX),
        Ok(Failed)
    );
}

#[test]
fn a_late_finding_still_blocks() {
    assert_eq!(
        record_scan(Scanning, MalwareFound, AT, AN_HOUR_LATER),
        Ok(Blocked)
    );
}

#[test]
fn a_report_can_only_tighten() {
    for (state, outcome, want) in [
        (Ready, NoKnownMalware, Ready),
        (Ready, MalwareFound, Blocked),
        (Ready, Unreadable, Blocked),
        (Blocked, NoKnownMalware, Blocked),
        (Blocked, MalwareFound, Blocked),
        (Blocked, Unreadable, Blocked),
        (Failed, NoKnownMalware, Failed),
        (Failed, MalwareFound, Blocked),
        (Failed, Unreadable, Blocked),
    ] {
        assert_eq!(
            record_scan(state, outcome, AT, SOON),
            Ok(want),
            "{state:?} {outcome:?}"
        );
    }
}

#[test]
fn nothing_scanned_can_be_reported_on() {
    for outcome in [NoKnownMalware, MalwareFound, Unreadable] {
        assert_eq!(
            record_scan(Uploading, outcome, AT, SOON).unwrap_err(),
            R::InvalidTransition
        );
    }
}

#[test]
fn only_exact_words_count_as_finding_nothing() {
    assert_eq!(ScanOutcome::from_report("no_known_malware"), NoKnownMalware);
    assert_eq!(ScanOutcome::from_report("malware_found"), MalwareFound);
    for report in [
        "",
        "ok",
        "OK",
        "clean",
        "safe",
        "NO_KNOWN_MALWARE",
        " no_known_malware",
        "no_known_malware\n",
        "error",
    ] {
        assert_eq!(ScanOutcome::from_report(report), Unreadable, "{report:?}");
    }
}

#[test]
fn a_scan_with_no_result_fails_after_an_hour() {
    assert_eq!(expire_scan(Scanning, AT, LAST_MOMENT), Scanning);
    assert_eq!(expire_scan(Scanning, AT, AN_HOUR_LATER), Failed);
    assert_eq!(expire_scan(Scanning, AT, AT - 5), Scanning);
    for state in [Uploading, Ready, Blocked, Failed] {
        assert_eq!(expire_scan(state, AT, AN_HOUR_LATER), state, "{state:?}");
    }
}

#[test]
fn only_ready_is_available() {
    for state in ObjectState::ALL {
        assert_eq!(state.is_available(), state == Ready, "{state:?}");
    }
}

#[test]
fn state_names_round_trip_and_unknown_names_are_nothing() {
    for state in ObjectState::ALL {
        assert_eq!(ObjectState::from_name(state.name()), Some(state));
    }
    for name in ["", "READY", "clean", "safe", "pending"] {
        assert_eq!(ObjectState::from_name(name), None, "{name:?}");
    }
}

#[test]
fn no_state_or_outcome_promises_safety() {
    for state in ObjectState::ALL {
        for word in ["safe", "clean", "virus"] {
            assert!(!state.name().contains(word), "{state:?}");
        }
    }
}

#[test]
fn refusals_have_stable_codes_and_carry_nothing_from_the_file() {
    for (refusal, code) in [
        (R::RoomArchived, "workspace_archived"),
        (R::TooLarge, "file_too_large"),
        (R::QuotaExceeded, "room_quota_exceeded"),
        (R::BadName, "invalid_file_name"),
        (R::Executable, "executable_refused"),
        (R::PasswordProtected, "password_protected_refused"),
        (R::MacroEnabled, "macro_file_refused"),
        (R::CannotInspect, "file_not_inspectable"),
        (R::NotOnList, "file_type_refused"),
        (R::Mismatch, "upload_mismatch"),
        (R::InvalidTransition, "invalid_transition"),
    ] {
        assert_eq!(refusal.code(), code);
    }
}

#[test]
fn a_served_file_is_always_an_attachment_with_a_harmless_header() {
    assert_eq!(
        attachment_header("notes.txt"),
        "attachment; filename=\"notes.txt\"; filename*=UTF-8''notes.txt"
    );
    for name in [
        "a\"; filename=evil.html",
        "a\r\nSet-Cookie: x=1.txt",
        "..\\..\\etc/passwd",
        "résumé.pdf",
        "%0d%0a.txt",
        "name;x=y.txt",
    ] {
        let header = attachment_header(name);
        let (plain, encoded) = header
            .strip_prefix("attachment; filename=\"")
            .and_then(|rest| rest.split_once("\"; filename*=UTF-8''"))
            .expect(name);
        assert!(
            plain
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ')),
            "{name}"
        );
        assert!(
            encoded
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '%')),
            "{name}"
        );
    }
    assert_eq!(
        attachment_header("\u{e9}\u{e9}"),
        "attachment; filename=\"__\"; filename*=UTF-8''%C3%A9%C3%A9"
    );
    assert_eq!(
        attachment_header("..."),
        "attachment; filename=\"download\"; filename*=UTF-8''..."
    );
}

#[test]
fn only_a_type_the_upload_rules_chose_is_served() {
    assert_eq!(
        served_media_type(Some("application/pdf")),
        "application/pdf"
    );
    assert_eq!(
        served_media_type(Some("text/plain; charset=utf-8")),
        "text/plain; charset=utf-8"
    );
    for stored in [
        Some("text/html"),
        Some("image/svg+xml"),
        Some("TEXT/PLAIN"),
        Some(""),
        None,
    ] {
        assert_eq!(
            served_media_type(stored),
            "application/octet-stream",
            "{stored:?}"
        );
    }
}
