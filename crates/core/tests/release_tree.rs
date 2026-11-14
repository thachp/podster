//! What a release may contain, from GitHub's tree alone (ADR 0010, the release job): the directory's entry, the answer's
//! size, the path rule, names and kinds refused, collisions, sizes and counts, and a fetched file against its entry.

use podster_core::release_tree::*;

const SHA: &str = "ce013625030ba8dba906f756967f9e9ca394464a";

fn file(path: &str, size: u64) -> TreeEntry<'_> {
    TreeEntry {
        path,
        mode: "100644",
        kind: EntryKind::Blob,
        size: Some(size),
        sha: SHA,
    }
}

fn dir(path: &str) -> TreeEntry<'_> {
    TreeEntry {
        path,
        mode: "040000",
        kind: EntryKind::Tree,
        size: None,
        sha: SHA,
    }
}

fn problems(entries: &[TreeEntry]) -> Vec<ContentProblem> {
    check_release_tree(entries, false).err().unwrap_or_default()
}

#[test]
fn the_directory_must_be_a_tree_in_the_commits_top_tree() {
    let top = [file("README.md", 10), dir(RELEASE_DIRECTORY)];
    assert_eq!(release_directory(&top), Ok(SHA));
    assert_eq!(
        release_directory(&[file("README.md", 10)]),
        Err(ContentProblem::DirectoryMissing)
    );
    // A file, a symlink and a submodule of that name are refused: nothing the repository controls is followed.
    for wrong in [
        TreeEntry {
            mode: "100644",
            kind: EntryKind::Blob,
            ..dir(RELEASE_DIRECTORY)
        },
        TreeEntry {
            mode: "120000",
            kind: EntryKind::Blob,
            ..dir(RELEASE_DIRECTORY)
        },
        TreeEntry {
            mode: "160000",
            kind: EntryKind::Commit,
            ..dir(RELEASE_DIRECTORY)
        },
        TreeEntry {
            mode: "040000",
            kind: EntryKind::Commit,
            ..dir(RELEASE_DIRECTORY)
        },
    ] {
        assert_eq!(
            release_directory(&[wrong]),
            Err(ContentProblem::DirectoryNotTree),
            "{wrong:?}"
        );
    }
    assert_eq!(EntryKind::parse("blob"), EntryKind::Blob);
    assert_eq!(EntryKind::parse("Blob"), EntryKind::Other);
}

#[test]
fn a_tree_answer_is_capped_before_it_is_parsed() {
    assert_eq!(tree_answer_fits(MAX_TREE_ANSWER_BYTES), Ok(()));
    assert_eq!(
        tree_answer_fits(MAX_TREE_ANSWER_BYTES + 1),
        Err(ContentProblem::TreeTooLarge)
    );
    assert_eq!(
        check_release_tree(&[file("a.html", 1)], true),
        Err(vec![ContentProblem::TreeTooLarge])
    );
    let entries: Vec<TreeEntry> = (0..MAX_TREE_ENTRIES).map(|_| dir("d")).collect();
    // A thousand entries are read; a thousand and one aren't, directories and empty ones included.
    assert_ne!(
        check_release_tree(&entries, false),
        Err(vec![ContentProblem::TreeTooLarge])
    );
    let mut over = entries;
    over.push(dir("e"));
    assert_eq!(
        check_release_tree(&over, false),
        Err(vec![ContentProblem::TreeTooLarge])
    );
}

#[test]
fn the_path_rule_holds_at_each_edge() {
    let at = |n: usize| "a".repeat(n);
    let long_ok = format!("{}/{}/{}/{}/a", at(255), at(255), at(255), at(254));
    assert_eq!(long_ok.len(), MAX_PATH_BYTES);
    assert_eq!(check_path(&long_ok), Ok(()));
    assert_eq!(
        check_path(&format!("{long_ok}a")),
        Err(PathProblem::TooLong)
    );
    assert_eq!(check_path(&at(255)), Ok(()));
    assert_eq!(check_path(&at(256)), Err(PathProblem::SegmentTooLong));
    for (path, problem) in [
        ("", PathProblem::EmptySegment),
        ("/a", PathProblem::EmptySegment),
        ("a/", PathProblem::EmptySegment),
        ("a//b", PathProblem::EmptySegment),
        (".", PathProblem::DotSegment),
        ("a/../b", PathProblem::DotSegment),
        ("a/./b", PathProblem::DotSegment),
        ("a\tb", PathProblem::ControlCharacter),
        ("a\nb", PathProblem::ControlCharacter),
        ("a\u{7f}b", PathProblem::ControlCharacter),
        ("a\u{85}b", PathProblem::ControlCharacter),
        ("a\\b", PathProblem::Backslash),
        ("a\u{FFFD}b", PathProblem::ReplacementCharacter),
        ("cafe\u{301}.html", PathProblem::NotNfc),
        (" a", PathProblem::EdgeSpace),
        ("a ", PathProblem::EdgeSpace),
        ("d /a", PathProblem::EdgeSpace),
        ("a\u{3000}", PathProblem::EdgeSpace),
    ] {
        assert_eq!(check_path(path), Err(problem), "{path:?}");
    }
    // What a path may hold: seen stored by GitHub, and passed for now.
    for ok in [
        "a b.html",
        ".hidden",
        "-dash",
        "q?.txt",
        "h#.txt",
        "p%20.txt",
        "a&b",
        "café.html",
        "日本.html",
        "a/b/c.css",
    ] {
        assert_eq!(check_path(ok), Ok(()), "{ok:?}");
    }
}

#[test]
fn the_platforms_names_and_the_marker_are_refused_anywhere() {
    for name in ["_headers", "_redirects", "_worker.js", "_routes.json"] {
        for path in [
            name.to_owned(),
            format!("deep/er/{name}"),
            name.to_uppercase(),
        ] {
            assert!(refused_name(&path), "{path}");
            assert!(
                problems(&[file(&path, 1)]).contains(&ContentProblem::RefusedName(path.clone())),
                "{path}"
            );
        }
        // A directory of that name too.
        assert!(refused_name(&format!("{name}/x.html")));
    }
    for path in [
        MARKER_PATH,
        ".well-known/podster-release.json/x",
        ".WELL-KNOWN/Podster-Release.json",
    ] {
        assert!(refused_name(path), "{path}");
    }
    for fine in [
        ".well-known/other.json",
        "headers",
        "x_headers",
        "_headers.txt",
        ".well-known/podster-release.jsonx",
    ] {
        assert!(!refused_name(fine), "{fine}");
    }
}

#[test]
fn only_files_and_directories_pass_and_symlinks_and_submodules_fail() {
    let plan = check_release_tree(
        &[
            file("index.html", 10),
            TreeEntry {
                mode: "100755",
                ..file("run.sh", 5)
            },
            dir("css"),
            file("css/a.css", 3),
        ],
        false,
    );
    assert_eq!(plan.as_ref().map(|p| p.files.len()), Ok(3));
    assert_eq!(plan.as_ref().map(|p| p.total_bytes), Ok(18));
    let link = TreeEntry {
        mode: "120000",
        ..file("link", 22)
    };
    let sub = TreeEntry {
        mode: "160000",
        kind: EntryKind::Commit,
        size: None,
        ..file("sub", 0)
    };
    let odd_commit = TreeEntry {
        mode: "100644",
        kind: EntryKind::Commit,
        size: None,
        ..file("odd", 0)
    };
    let other = TreeEntry {
        mode: "100664",
        ..file("other", 1)
    };
    let weird = TreeEntry {
        mode: "040000",
        kind: EntryKind::Blob,
        ..file("weird", 1)
    };
    let found = problems(&[file("index.html", 1), link, sub, odd_commit, other, weird]);
    assert_eq!(
        found,
        [
            ContentProblem::Symlink("link".into()),
            ContentProblem::Submodule("sub".into()),
            ContentProblem::Submodule("odd".into()),
            ContentProblem::UnknownEntry("other".into()),
            ContentProblem::UnknownEntry("weird".into()),
        ]
    );
}

#[test]
fn a_file_needs_a_size_and_a_directory_never_has_one() {
    let nosize = TreeEntry {
        size: None,
        ..file("a.html", 0)
    };
    assert_eq!(
        problems(&[nosize]),
        [ContentProblem::FileWithoutSize("a.html".into())]
    );
    assert!(check_release_tree(&[dir("d"), file("d/a.html", 1)], false).is_ok());
}

#[test]
fn case_twins_and_two_files_at_one_address_fail() {
    assert_eq!(
        problems(&[file("A.html", 1), file("a.html", 1)]),
        [
            ContentProblem::CaseTwins("A.html".into(), "a.html".into()),
            ContentProblem::SameAddress("A.html".into(), "a.html".into())
        ]
    );
    // Full case folding: ß and SS are one name.
    assert!(problems(&[file("straße.txt", 1), file("STRASSE.txt", 1)])
        .iter()
        .any(|p| p.code() == "release_path_collision"));
    for (a, b) in [
        ("page.html", "page/index.html"),
        ("page", "page.html"),
        ("index.html", "index.html"),
    ] {
        if a == b {
            continue;
        }
        let found = problems(&[file(a, 1), dir("page"), file(b, 1)]);
        assert!(
            found.contains(&ContentProblem::SameAddress(a.into(), b.into())),
            "{a} {b}: {found:?}"
        );
    }
    assert_eq!(served_address("index.html"), "");
    assert_eq!(served_address("docs/index.html"), "docs");
    assert_eq!(served_address("page.html"), "page");
    assert_eq!(served_address("docs/page.html"), "docs/page");
    assert_eq!(served_address(".html"), ".html");
    assert_eq!(served_address("app.js"), "app.js");
    assert!(check_release_tree(
        &[
            file("a.html", 1),
            file("b.html", 1),
            dir("c"),
            file("c/index.html", 1)
        ],
        false
    )
    .is_ok());
}

#[test]
fn sizes_and_counts_hold_at_each_edge() {
    assert!(check_release_tree(&[file("a", MAX_FILE_BYTES)], false).is_ok());
    assert_eq!(
        problems(&[file("a", MAX_FILE_BYTES + 1)]),
        [ContentProblem::FileTooLarge("a".into())]
    );
    let five: Vec<String> = (0..5).map(|i| format!("f{i}")).collect();
    let full: Vec<TreeEntry> = five.iter().map(|p| file(p, MAX_FILE_BYTES)).collect();
    assert!(check_release_tree(&full, false).is_ok());
    let mut over = full.clone();
    over.push(file("g", 1));
    assert_eq!(
        problems(&over),
        [ContentProblem::TooLarge(MAX_RELEASE_BYTES + 1)]
    );
    let names: Vec<String> = (0..=MAX_FILES).map(|i| format!("f{i:03}.txt")).collect();
    let at_cap: Vec<TreeEntry> = names.iter().take(MAX_FILES).map(|p| file(p, 1)).collect();
    assert_eq!(
        check_release_tree(&at_cap, false).map(|p| p.files.len()),
        Ok(300)
    );
    let past: Vec<TreeEntry> = names.iter().map(|p| file(p, 1)).collect();
    assert_eq!(problems(&past), [ContentProblem::TooManyFiles(301)]);
    // Nothing to serve fails, directories alone included.
    assert_eq!(problems(&[]), [ContentProblem::Empty]);
    assert_eq!(problems(&[dir("d")]), [ContentProblem::Empty]);
}

#[test]
fn every_problem_is_reported_and_the_plan_is_in_path_order() {
    let found = problems(&[
        file("_headers", 1),
        file("a\\b", 1),
        file("x", MAX_FILE_BYTES + 1),
    ]);
    let codes: Vec<&str> = found.iter().map(ContentProblem::code).collect();
    assert_eq!(
        codes,
        [
            "release_refused_name",
            "release_bad_path",
            "release_file_too_large"
        ]
    );
    let plan = check_release_tree(&[file("z.css", 2), file("a.html", 1)], false);
    let paths: Vec<String> = plan
        .map(|p| p.files.into_iter().map(|f| f.path).collect())
        .unwrap_or_default();
    assert_eq!(paths, ["a.html", "z.css"]);
}

#[test]
fn a_fetched_file_matches_its_entry_by_length_and_blob_sha() {
    let planned = PlannedFile {
        path: "a".into(),
        size: 6,
        sha: SHA.into(),
    };
    assert_eq!(check_fetched(&planned, 6, SHA), Ok(()));
    assert_eq!(check_fetched(&planned, 6, &SHA.to_uppercase()), Ok(()));
    assert_eq!(check_fetched(&planned, 7, SHA), Err(FetchMismatch::Size));
    assert_eq!(
        check_fetched(&planned, 6, "0000000000000000000000000000000000000000"),
        Err(FetchMismatch::Sha)
    );
    assert_eq!(FetchMismatch::Sha.code(), "release_file_mismatch");
}

#[test]
fn nothing_is_served_at_the_markers_address() {
    // `.html` stripped, this would be served exactly where the job's marker is.
    let twin = ".well-known/podster-release.json.html";
    assert!(!refused_name(twin));
    let found = problems(&[dir(".well-known"), file(twin, 1), file("index.html", 1)]);
    assert!(
        found.contains(&ContentProblem::SameAddress(
            MARKER_PATH.into(),
            twin.into()
        )),
        "{found:?}"
    );
    // And in another case, since addresses are compared folded.
    let upper = ".WELL-KNOWN/podster-release.json.html";
    assert!(problems(&[file(upper, 1)])
        .iter()
        .any(|p| p.code() == "release_path_collision"));
    // Its own directory index would be too.
    let index = ".well-known/podster-release.json/index.html";
    assert!(refused_name(index));
}

#[test]
fn invisible_characters_are_refused() {
    for path in [
        "a\u{202E}b.html", // right-to-left override (Cf)
        "a\u{200B}b.html", // zero-width space (Cf)
        "a\u{200D}b.html", // zero-width joiner (Cf)
        "a\u{FEFF}b.html", // byte-order mark (Cf)
        "a\u{2066}b.html", // left-to-right isolate (Cf)
        "a\u{2028}b.html", // line separator (Zl)
        "a\u{2029}b.html", // paragraph separator (Zp)
        "a\u{00A0}b.html", // no-break space
        "a\u{3000}b.html", // ideographic space
        "a\u{2009}b.html", // thin space
    ] {
        assert_eq!(check_path(path), Err(PathProblem::Invisible), "{path:?}");
    }
    assert_eq!(check_path("a b.html"), Ok(()));
}

#[test]
fn twins_are_found_by_full_case_folding_after_nfkc() {
    for (a, b) in [
        ("ẞ.txt", "ß.txt"),
        ("ß.txt", "ss.txt"),
        ("ﬁle.txt", "file.txt"),
        ("Ａ.txt", "a.txt"),
        ("ǅ.txt", "dž.txt"),
        ("Σ.txt", "ς.txt"),
    ] {
        assert_eq!(fold(a), fold(b), "{a} {b}");
        let found = problems(&[file(a, 1), file(b, 1)]);
        assert!(
            found.iter().any(|p| p.code() == "release_path_collision"),
            "{a} {b}: {found:?}"
        );
    }
    assert_ne!(fold("a.txt"), fold("b.txt"));
}

#[test]
fn a_path_is_folded_before_html_is_stripped() {
    for twin in [
        ".well-known/podster-release.json.HTML",
        ".well-known/podster-release.json.ｈｔｍｌ",
        ".well-known/podster-release.json.Html",
    ] {
        let found = problems(&[file(twin, 1)]);
        assert!(
            found.contains(&ContentProblem::SameAddress(
                MARKER_PATH.into(),
                twin.into()
            )),
            "{twin}: {found:?}"
        );
    }
    // And between two files of the repository.
    let found = problems(&[file("page.HTML", 1), file("page", 1)]);
    assert!(
        found.iter().any(|p| p.code() == "release_path_collision"),
        "{found:?}"
    );
    let found = problems(&[file("page.ｈｔｍｌ", 1), file("page.html", 1)]);
    assert!(
        found.iter().any(|p| p.code() == "release_path_collision"),
        "{found:?}"
    );
}

#[test]
fn a_file_is_served_with_a_type_from_podsters_own_list_by_its_last_extension() {
    for (path, wanted) in [
        ("index.html", "text/html; charset=utf-8"),
        ("a/b/PAGE.HTM", "text/html; charset=utf-8"),
        ("app.min.js", "text/javascript; charset=utf-8"),
        ("mod.mjs", "text/javascript; charset=utf-8"),
        ("style.css", "text/css; charset=utf-8"),
        ("data.json", "application/json"),
        ("app.js.map", "application/json"),
        ("site.webmanifest", "application/manifest+json"),
        ("logo.svg", "image/svg+xml"),
        ("p.png", "image/png"),
        ("p.JPEG", "image/jpeg"),
        ("f.woff2", "font/woff2"),
        ("m.wasm", "application/wasm"),
        // Not listed, no extension, a dot file, a directory with a dot in its name: bytes to download.
        ("archive.zip", "application/octet-stream"),
        ("LICENSE", "application/octet-stream"),
        (".gitkeep", "application/octet-stream"),
        ("v1.2/readme", "application/octet-stream"),
        ("page.html.bak", "application/octet-stream"),
        ("", "application/octet-stream"),
    ] {
        assert_eq!(served_type(path), wanted, "{path}");
    }
    // A script is never served as HTML whatever precedes its last extension, and HTML never as a script.
    assert_ne!(served_type("x.html.js"), served_type("x.js.html"));
}

#[test]
fn a_manifest_hash_changes_with_the_bytes_and_with_the_type_and_is_known_before_a_file_is_fetched()
{
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let html = manifest_hash_input(sha, served_type("a.html"));
    let text = manifest_hash_input(sha, served_type("a.txt"));
    let other = manifest_hash_input(
        "1123456789abcdef0123456789abcdef01234567",
        served_type("a.html"),
    );
    assert_ne!(
        html, text,
        "the same bytes served as another type hash differently"
    );
    assert_ne!(html, other, "other bytes hash differently");
    // The sha is taken in lower case, so the same file read twice hashes the same.
    assert_eq!(
        manifest_hash_input(&sha.to_ascii_uppercase(), "t"),
        manifest_hash_input(sha, "t")
    );
    // One zero byte between the two parts, so no sha and type run together into another pair's.
    assert_eq!(html.len(), 40 + 1 + "text/html; charset=utf-8".len());
    assert_eq!(html.get(40), Some(&0));
    let digest = "AB".repeat(32);
    assert_eq!(
        manifest_hash(&digest).as_deref(),
        Some("ab".repeat(16).as_str())
    );
    for bad in [
        "",
        "ab",
        &"ab".repeat(31),
        &"zz".repeat(32),
        &"ab".repeat(33),
    ] {
        assert_eq!(manifest_hash(bad), None, "{bad}");
    }
    assert_eq!(git_blob_header(0), b"blob 0\0");
    assert_eq!(git_blob_header(5_000_000), b"blob 5000000\0");
}

#[test]
fn only_a_commit_the_repository_doesnt_have_ends_a_release_at_the_read() {
    let codes = [
        (
            ReadProblem::NotConfigured,
            "release_read_not_configured",
            false,
        ),
        (ReadProblem::Unavailable, "release_read_unavailable", false),
        (
            ReadProblem::CommitUnreadable,
            "release_commit_unreadable",
            true,
        ),
    ];
    for (problem, code, fails) in codes {
        assert_eq!((problem.code(), problem.fails_release()), (code, fails));
    }
}
