#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! What a release that carries code may hold (ADR 0010's revision, stage 1): which files are modules, the manifest and
//! its two fields, the caps on modules, and that nothing in the repository becomes configuration. Each boundary both
//! ways.

use podster_core::app_code::*;
use podster_core::release_tree::{PlannedFile, ReleasePlan};

const SHA: &str = "ce013625030ba8dba906f756967f9e9ca394464a";
const GOOD: &[u8] = br#"{"main":"index.js","store":true}"#;

fn f(path: &str, size: u64) -> PlannedFile {
    PlannedFile {
        path: path.to_owned(),
        size,
        sha: SHA.to_owned(),
    }
}

fn plan(files: Vec<PlannedFile>) -> ReleasePlan {
    let total_bytes = files.iter().map(|f| f.size).sum();
    ReleasePlan { files, total_bytes }
}

fn layout(files: Vec<PlannedFile>) -> CodeLayout {
    match split_release(&plan(files)) {
        Ok(ReleaseShape::Code(layout)) => layout,
        other => panic!("expected code, got {other:?}"),
    }
}

fn split_err(files: Vec<PlannedFile>) -> Vec<CodeProblem> {
    split_release(&plan(files)).expect_err("expected a refusal")
}

fn app(extra: Vec<PlannedFile>) -> Vec<PlannedFile> {
    let mut files = vec![
        f("index.html", 100),
        f("app.js", 100),
        f(MANIFEST_PATH, 40),
        f("worker/index.js", 100),
    ];
    files.extend(extra);
    files
}

#[test]
fn a_release_with_no_manifest_and_no_modules_is_static_as_before() {
    let files = vec![
        f("index.html", 10),
        f("app.js", 10),
        f("docs/podster-app.json", 10),
        f("lib/worker/x.js", 10),
        f("wrangler.toml", 10),
    ];
    assert_eq!(split_release(&plan(files)), Ok(ReleaseShape::Static));
}

#[test]
fn modules_and_the_manifest_are_never_static_files() {
    let l = layout(app(vec![f("worker/lib/util.mjs", 50)]));
    assert_eq!(l.manifest.path, MANIFEST_PATH);
    let names: Vec<_> = l.modules.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["index.js", "lib/util.mjs"]);
    assert_eq!(l.modules_bytes, 150);
    let served: Vec<_> = l.static_files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(served, ["app.js", "index.html"]);
}

#[test]
fn a_page_script_outside_the_modules_directory_stays_a_static_file() {
    let l = layout(app(vec![f("workers/x.js", 1), f("assets/worker/y.js", 1)]));
    assert!(l.static_files.iter().any(|f| f.path == "workers/x.js"));
    assert!(l
        .static_files
        .iter()
        .any(|f| f.path == "assets/worker/y.js"));
    assert_eq!(l.modules.len(), 1);
}

#[test]
fn modules_without_a_manifest_are_refused() {
    assert_eq!(
        split_err(vec![f("index.html", 1), f("worker/index.js", 1)]),
        [CodeProblem::ManifestMissing]
    );
}

#[test]
fn a_manifest_alone_carries_code_and_its_main_must_then_be_a_module() {
    let l = layout(vec![f("index.html", 1), f(MANIFEST_PATH, 30)]);
    assert!(l.modules.is_empty());
    assert_eq!(
        check_code_release(&l, GOOD),
        Err(vec![CodeProblem::MainNotAModule])
    );
}

#[test]
fn a_manifest_of_another_case_or_a_path_under_it_is_refused() {
    for path in ["Podster-App.json", "PODSTER-APP.JSON", "podster-app.json/x"] {
        let problems = split_err(vec![f("index.html", 1), f(path, 10)]);
        assert_eq!(problems, [CodeProblem::ManifestName(path.to_owned())]);
    }
    // Beside the real manifest, too.
    assert_eq!(
        split_err(app(vec![f("Podster-app.json", 1)])),
        [CodeProblem::ManifestName("Podster-app.json".to_owned())]
    );
}

#[test]
fn the_modules_directory_in_another_case_or_as_a_file_is_refused() {
    for path in ["Worker/index.js", "WORKER/a.js", "worker"] {
        assert_eq!(
            split_err(app(vec![f(path, 1)])),
            [CodeProblem::ModulesDirectoryName(path.to_owned())],
            "{path}"
        );
    }
}

#[test]
fn a_module_must_be_a_javascript_module_by_its_extension() {
    for name in ["index.js", "a.mjs", "lib/b.js", "c.d.mjs"] {
        let path = format!("worker/{name}");
        assert!(
            split_release(&plan(app(vec![f(&path, 1)]))).is_ok(),
            "{path}"
        );
    }
    for name in [
        "a.ts", "a.py", "a.wasm", "a.JS", "a.MJS", "a.json", "a", ".js", "lib/.mjs", "a.js.map",
        "a.cjs",
    ] {
        let path = format!("worker/{name}");
        assert_eq!(
            split_err(app(vec![f(&path, 1)])),
            [CodeProblem::ModuleKind(path.clone())],
            "{path}"
        );
    }
}

#[test]
fn a_module_is_capped_in_size_at_the_boundary() {
    assert!(split_release(&plan(app(vec![f("worker/big.js", MAX_MODULE_BYTES)]))).is_ok());
    assert_eq!(
        split_err(app(vec![f("worker/big.js", MAX_MODULE_BYTES + 1)])),
        [CodeProblem::ModuleTooLarge("worker/big.js".to_owned())]
    );
}

#[test]
fn modules_are_capped_in_count_at_the_boundary() {
    let at = |n: usize| {
        let mut files = vec![f(MANIFEST_PATH, 10)];
        files.extend((0..n).map(|i| f(&format!("worker/m{i}.js"), 1)));
        files
    };
    assert!(split_release(&plan(at(MAX_MODULES))).is_ok());
    assert_eq!(
        split_err(at(MAX_MODULES + 1)),
        [CodeProblem::TooManyModules(MAX_MODULES + 1)]
    );
}

#[test]
fn modules_are_capped_in_total_size_at_the_boundary() {
    let two = |second: u64| {
        vec![
            f(MANIFEST_PATH, 10),
            f("worker/a.js", MAX_MODULE_BYTES),
            f("worker/b.js", MAX_MODULE_BYTES),
            f("worker/c.js", second),
        ]
    };
    let at = MAX_MODULES_BYTES - 2 * MAX_MODULE_BYTES;
    assert!(split_release(&plan(two(at))).is_ok());
    assert_eq!(
        split_err(two(at + 1)),
        [CodeProblem::ModulesTooLarge(MAX_MODULES_BYTES + 1)]
    );
}

#[test]
fn the_manifests_entry_is_capped_before_it_is_fetched() {
    assert!(split_release(&plan(vec![
        f(MANIFEST_PATH, MAX_MANIFEST_BYTES),
        f("worker/a.js", 1)
    ]))
    .is_ok());
    assert_eq!(
        split_err(vec![
            f(MANIFEST_PATH, MAX_MANIFEST_BYTES + 1),
            f("worker/a.js", 1)
        ]),
        [CodeProblem::ManifestTooLarge(MAX_MANIFEST_BYTES + 1)]
    );
}

#[test]
fn a_wrangler_file_anywhere_in_a_code_release_is_refused() {
    for path in [
        "wrangler.toml",
        "wrangler.json",
        "wrangler.jsonc",
        "WRANGLER.TOML",
        "sub/dir/wrangler.jsonc",
        "worker/wrangler.json",
    ] {
        let problems = split_err(app(vec![f(path, 1)]));
        assert!(
            problems.contains(&CodeProblem::ConfigFile(path.to_owned())),
            "{path}: {problems:?}"
        );
    }
    for path in [
        "wrangler.md",
        "my-wrangler.toml",
        "wrangler.toml.txt",
        "wrangler",
    ] {
        assert!(
            split_release(&plan(app(vec![f(path, 1)]))).is_ok(),
            "{path}"
        );
    }
}

#[test]
fn every_problem_is_returned_with_its_code() {
    let problems = split_err(vec![
        f("worker/a.ts", MAX_MODULE_BYTES + 1),
        f("wrangler.toml", 1),
    ]);
    let codes: Vec<_> = problems.iter().map(CodeProblem::code).collect();
    assert_eq!(
        codes,
        [
            "release_module_kind",
            "release_module_too_large",
            "release_config_file",
            "release_manifest_missing"
        ]
    );
}

#[test]
fn a_good_manifest_reads_and_main_names_a_module() {
    let l = layout(app(vec![]));
    let release = check_code_release(&l, GOOD).expect("reads");
    assert_eq!(release.main, "index.js");
    assert!(release.wants_store);
    assert_eq!(release.modules.len(), 1);
    assert_eq!(release.static_files.len(), 2);
    let no_store = check_code_release(
        &l,
        b" {\n  \"store\" : false ,\t\"main\":\"index.js\"\r\n} \n",
    )
    .unwrap();
    assert!(!no_store.wants_store);
}

#[test]
fn main_must_be_exactly_a_modules_name() {
    let l = layout(app(vec![f("worker/lib/a.js", 1)]));
    assert!(check_code_release(&l, br#"{"main":"lib/a.js","store":false}"#).is_ok());
    for main in [
        "./index.js",
        "worker/index.js",
        "Index.js",
        "index",
        "index.mjs",
        "",
        "/index.js",
        "lib//a.js",
        "../index.js",
        "app.js",
    ] {
        let bytes = format!(r#"{{"main":"{main}","store":false}}"#);
        assert_eq!(
            check_code_release(&l, bytes.as_bytes()),
            Err(vec![CodeProblem::MainNotAModule]),
            "{main}"
        );
    }
}

#[test]
fn the_manifests_bytes_are_capped_at_the_boundary() {
    let padded = |len: usize| {
        let mut bytes = GOOD.to_vec();
        bytes.resize(len, b' ');
        bytes
    };
    assert!(parse_manifest(&padded(MAX_MANIFEST_BYTES as usize)).is_ok());
    assert_eq!(
        parse_manifest(&padded(MAX_MANIFEST_BYTES as usize + 1)),
        Err(vec![CodeProblem::ManifestTooLarge(MAX_MANIFEST_BYTES + 1)])
    );
}

#[test]
fn configuration_in_the_manifest_is_refused_under_its_own_code() {
    for key in CONFIG_KEYS {
        let bytes = format!(r#"{{"main":"index.js","store":true,"{key}":[]}}"#);
        assert_eq!(
            parse_manifest(bytes.as_bytes()),
            Err(vec![CodeProblem::ManifestConfigKey(key.to_owned())]),
            "{key}"
        );
    }
    let bytes = br#"{"main":"index.js","store":true,"compatibility_flags":[],"bindings":{}}"#;
    let codes: Vec<_> = parse_manifest(bytes)
        .unwrap_err()
        .iter()
        .map(CodeProblem::code)
        .collect();
    assert_eq!(
        codes,
        ["release_manifest_config", "release_manifest_config"]
    );
}

#[test]
fn any_other_key_is_refused() {
    for key in ["Main", "STORE", "main ", "description", "version", "entry"] {
        let bytes = format!(r#"{{"main":"index.js","store":true,"{key}":"x"}}"#);
        assert_eq!(
            parse_manifest(bytes.as_bytes()),
            Err(vec![CodeProblem::ManifestUnknownKey(key.to_owned())]),
            "{key}"
        );
    }
}

#[test]
fn each_field_is_required_once_and_of_its_kind() {
    assert_eq!(
        parse_manifest(br#"{"main":"index.js"}"#),
        Err(vec![CodeProblem::ManifestFieldMissing("store".to_owned())])
    );
    assert_eq!(
        parse_manifest(br#"{"store":true}"#),
        Err(vec![CodeProblem::ManifestFieldMissing("main".to_owned())])
    );
    assert_eq!(
        parse_manifest(b"{}"),
        Err(vec![
            CodeProblem::ManifestFieldMissing("main".to_owned()),
            CodeProblem::ManifestFieldMissing("store".to_owned())
        ])
    );
    assert_eq!(
        parse_manifest(br#"{"main":"a.js","main":"b.js","store":true}"#),
        Err(vec![CodeProblem::ManifestDuplicateKey("main".to_owned())])
    );
    assert_eq!(
        parse_manifest(br#"{"main":"a.js","store":true,"store":false}"#),
        Err(vec![CodeProblem::ManifestDuplicateKey("store".to_owned())])
    );
    for (bytes, key) in [
        (&br#"{"main":1,"store":true}"#[..], "main"),
        (br#"{"main":null,"store":true}"#, "main"),
        (br#"{"main":true,"store":true}"#, "main"),
        (br#"{"main":[],"store":true}"#, "main"),
        (br#"{"main":"a.js","store":"true"}"#, "store"),
        (br#"{"main":"a.js","store":1}"#, "store"),
        (br#"{"main":"a.js","store":{}}"#, "store"),
    ] {
        assert_eq!(
            parse_manifest(bytes),
            Err(vec![CodeProblem::ManifestValue(key.to_owned())]),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
}

#[test]
fn anything_but_one_flat_object_is_unreadable() {
    for bytes in [
        &b""[..],
        b" ",
        b"[]",
        b"null",
        b"\"main\"",
        b"{",
        b"}",
        br#"{"main":"a.js","store":true"#,
        br#"{"main":"a.js","store":true,}"#,
        br#"{,"main":"a.js","store":true}"#,
        br#"{"main":"a.js" "store":true}"#,
        br#"{"main" "a.js","store":true}"#,
        br#"{main:"a.js","store":true}"#,
        br#"{'main':'a.js','store':true}"#,
        br#"{"main":"a.js","store":True}"#,
        br#"{"main":"a.js","store":tru}"#,
        br#"{"main":"a.js","store":true}{}"#,
        br#"{"main":"a.js","store":true} x"#,
        br#"{"main":"a.js","store":true}// note"#,
        br#"{"main":"a.js","store":true,"x":{"y":1}}"#,
        br#"{"main":"a.js","store":true,"x":[1]}"#,
        b"{\"main\":\"a\\u002ejs\",\"store\":true}",
        br#"{"main":"a\/b.js","store":true}"#,
        br#"{"ma\in":"a.js","store":true}"#,
        b"{\"main\":\"a\tb.js\",\"store\":true}",
        b"{\"main\":\"a\nb.js\",\"store\":true}",
        b"\xEF\xBB\xBF{\"main\":\"a.js\",\"store\":true}",
        b"{\"main\":\"\xff.js\",\"store\":true}",
        b"{\"main\":\"a.js\",\"store\":true}\x00",
        b"{\x0c\"main\":\"a.js\",\"store\":true}",
    ] {
        assert_eq!(
            parse_manifest(bytes),
            Err(vec![CodeProblem::ManifestUnreadable]),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
}

#[test]
fn a_non_ascii_main_is_read_as_its_bytes() {
    assert_eq!(
        parse_manifest("{\"main\":\"é.js\",\"store\":false}".as_bytes()),
        Ok(Manifest {
            main: "é.js".to_owned(),
            store: false
        })
    );
}

#[test]
fn the_fixed_names_podster_writes() {
    assert_eq!(MODULE_UPLOAD_TYPE, "application/javascript+module");
    assert_eq!(STORE_BINDING_NAME, "STORE");
    assert_eq!(MANIFEST_FIELDS, ["main", "store"]);
    // No manifest field is a configuration key, and the manifest and modules directory are each one plain segment.
    assert!(MANIFEST_FIELDS.iter().all(|f| !CONFIG_KEYS.contains(f)));
    assert!(!MANIFEST_PATH.contains('/') && !MODULES_DIRECTORY.contains('/'));
}

#[test]
fn a_release_asks_for_its_store_only_through_a_whole_manifest_that_says_so() {
    let files = app(vec![]);
    // The control: a code release whose manifest says `true`.
    assert!(asks_for_store(&plan(files.clone()), Some(GOOD)));
    // One change away, each asks for none.
    assert!(!asks_for_store(
        &plan(files.clone()),
        Some(br#"{"main":"index.js","store":false}"#)
    ));
    // A manifest that isn't read whole asks for nothing: no store is made on a guess.
    for bad in [
        &br#"{"main":"index.js","store":"true"}"#[..],
        br#"{"main":"index.js","store":true,"store":true}"#,
        br#"{"main":"index.js","store":true,"d1_databases":[]}"#,
        br#"{"main":"other.js","store":true}"#,
        br#"{"store":true}"#,
        b"",
    ] {
        assert!(
            !asks_for_store(&plan(files.clone()), Some(bad)),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
    // No manifest's bytes, or a tree that isn't a whole code release's: none.
    assert!(!asks_for_store(&plan(files.clone()), None));
    assert!(!asks_for_store(
        &plan(vec![f("index.html", 10), f("app.js", 10)]),
        Some(GOOD)
    ));
    assert!(!asks_for_store(
        &plan(app(vec![f("worker/data.txt", 10)])),
        Some(GOOD)
    ));
}

#[test]
fn a_modules_name_is_plain_ascii_or_the_module_is_refused() {
    // Each of these goes into the upload as it is: a part's name and, for the entry module, the metadata's.
    for name in ["index.js", "lib/a-b_c.1.mjs", "A/B/C.js", "x..js"] {
        assert!(module_name_form(name), "{name}");
        let path = format!("worker/{name}");
        assert!(
            split_release(&plan(app(vec![f(&path, 1)]))).is_ok(),
            "{path}"
        );
    }
    // One character away, each would need quoting or escaping in a header or JSON, and is refused by its own code.
    for name in [
        "a\".js", "a b.js", "a;b.js", "é.js", "a\\b.js", "a'.js", "a=b.js", "a%b.js", "a+b.js",
    ] {
        assert!(!module_name_form(name), "{name:?}");
        let path = format!("worker/{name}");
        let problems = split_err(app(vec![f(&path, 1)]));
        assert_eq!(
            problems,
            [CodeProblem::ModuleName(path.clone())],
            "{path:?}"
        );
        assert_eq!(
            problems.first().map(CodeProblem::code),
            Some("release_module_name")
        );
    }
    assert!(!module_name_form(""));
}

#[test]
fn the_compatibility_date_is_one_fixed_constant() {
    assert_eq!(COMPATIBILITY_DATE, "2026-11-01");
    // It is a date's form, so it goes into the metadata as it is.
    let b = COMPATIBILITY_DATE.as_bytes();
    assert_eq!(b.len(), 10);
    assert!(b.iter().enumerate().all(|(at, c)| if at == 4 || at == 7 {
        *c == b'-'
    } else {
        c.is_ascii_digit()
    }));
}

#[test]
fn a_static_tree_uploads_as_static_files_whatever_manifest_bytes_are_given() {
    let files = vec![f("index.html", 10), f("app.js", 10), f("wrangler.toml", 10)];
    assert_eq!(
        upload_form(&plan(files.clone()), None),
        Ok(UploadForm::Static)
    );
    assert_eq!(
        upload_form(&plan(files), Some(GOOD)),
        Ok(UploadForm::Static)
    );
}

#[test]
fn a_whole_code_release_uploads_as_code_with_its_static_files_apart() {
    let form = upload_form(&plan(app(vec![f("worker/lib/a.mjs", 5)])), Some(GOOD));
    let Ok(UploadForm::Code(release)) = form else {
        panic!("expected code, got {form:?}");
    };
    assert_eq!(release.main, "index.js");
    assert!(release.wants_store);
    assert_eq!(
        release
            .modules
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>(),
        ["index.js", "lib/a.mjs"]
    );
    // Neither the manifest nor a module is ever a static file.
    assert_eq!(
        release
            .static_files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["app.js", "index.html"]
    );
    let no_store = upload_form(
        &plan(app(vec![])),
        Some(br#"{"main":"index.js","store":false}"#),
    );
    assert!(matches!(
        no_store,
        Ok(UploadForm::Code(CodeRelease {
            wants_store: false,
            ..
        }))
    ));
}

#[test]
fn a_code_release_that_fails_cores_checks_fails_by_its_first_problems_code_and_is_never_static() {
    // The tree's problems, first by the order found.
    assert_eq!(
        upload_form(
            &plan(app(vec![f("worker/a.ts", 1), f("wrangler.toml", 1)])),
            Some(GOOD)
        )
        .map_err(|p| p.code()),
        Err("release_module_kind")
    );
    assert_eq!(
        upload_form(&plan(vec![f("worker/index.js", 1)]), Some(GOOD)).map_err(|p| p.code()),
        Err("release_manifest_missing")
    );
    // The manifest's problems.
    for (bytes, code) in [
        (
            &br#"{"main":"other.js","store":true}"#[..],
            "release_main_not_a_module",
        ),
        (
            br#"{"main":"index.js","store":"true"}"#,
            "release_manifest_value",
        ),
        (
            br#"{"main":"index.js","store":true,"bindings":[]}"#,
            "release_manifest_config",
        ),
        (br#"{"main":"index.js"}"#, "release_manifest_field_missing"),
        (b"not json", "release_manifest_unreadable"),
    ] {
        assert_eq!(
            upload_form(&plan(app(vec![])), Some(bytes)).map_err(|p| p.code()),
            Err(code),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
    // A code tree whose manifest's bytes weren't kept can't be read.
    assert_eq!(
        upload_form(&plan(app(vec![])), None).map_err(|p| p.code()),
        Err("release_manifest_unreadable")
    );
}

#[test]
#[allow(clippy::assertions_on_constants)]
fn the_gate_for_apps_with_code_is_closed_and_one_constant() {
    // Flipped only by the PR that shows stage 1's "before code is turned on" items (the M6 plan's gate).
    assert!(!CODE_RELEASES_COMPLETE);
    assert_eq!(
        CodeProblem::CodeNotAvailable.code(),
        "release_code_not_available"
    );
}

#[test]
fn closed_only_a_static_release_goes_on_and_every_other_fails_code_not_available() {
    let static_files = vec![f("index.html", 10), f("app.js", 10), f("wrangler.toml", 10)];
    // A static tree goes on, open or closed, whatever manifest bytes are given.
    for open in [false, true] {
        for bytes in [None, Some(GOOD)] {
            assert_eq!(
                admit(upload_form(&plan(static_files.clone()), bytes), open),
                Ok(UploadForm::Static)
            );
        }
    }
    // Closed: a whole code release, with or without its store, fails by the gate's code and never as static files.
    for bytes in [GOOD, br#"{"main":"index.js","store":false}"#] {
        assert_eq!(
            admit(upload_form(&plan(app(vec![])), Some(bytes)), false).map_err(|p| p.code()),
            Err("release_code_not_available")
        );
    }
    // Closed: a tree that only tries to carry code fails by the gate's code too, not by core's checks.
    for (files, bytes) in [
        (vec![f("worker/index.js", 1)], Some(GOOD)),
        (vec![f("index.html", 1), f(MANIFEST_PATH, 10)], None),
        (app(vec![f("worker/a.ts", 1)]), Some(GOOD)),
        (vec![f("index.html", 1), f("Worker/x.js", 1)], None),
        (app(vec![]), Some(&b"not json"[..])),
        (app(vec![]), None),
    ] {
        assert_eq!(
            admit(upload_form(&plan(files.clone()), bytes), false).map_err(|p| p.code()),
            Err("release_code_not_available"),
            "{files:?}"
        );
    }
}

#[test]
fn open_the_gate_answers_the_upload_form_unchanged() {
    let whole = upload_form(&plan(app(vec![])), Some(GOOD));
    assert!(matches!(whole, Ok(UploadForm::Code(_))));
    assert_eq!(admit(whole.clone(), true), whole);
    let refused = upload_form(&plan(app(vec![f("worker/a.ts", 1)])), Some(GOOD));
    assert_eq!(
        admit(refused, true).map_err(|p| p.code()),
        Err("release_module_kind")
    );
}
