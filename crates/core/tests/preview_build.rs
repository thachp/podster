#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! The build ID and the publish binding (M8 step 4; the preview plan's 4.1 to 4.3, decisions 254 and 259): `bld_` and
//! 32 hexadecimal characters of a SHA-256 over Podster's upload form, the commit, the release directory's tree, every
//! served file's manifest hash and every module's SHA-256; a publish names an immutable preview release that reached
//! `served`, and its approval is valid only for that release's own build.

use podster_core::preview::Environment;
use podster_core::preview_build::*;
use podster_core::release::ReleaseState;
use podster_core::release_tree::MARKER_PATH;

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const TREE: &str = "89abcdef0123456789abcdef0123456789abcdef";
const H1: &str = "00112233445566778899aabbccddeeff";
const H2: &str = "ffeeddccbbaa99887766554433221100";
const M1: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const M2: &str = "0000000000000000000000000000000000000000000000000000000000000002";
const PREVIEW_ID: &str = "rel_0000000000000000000000000000000a";

fn files() -> Vec<BuildFile<'static>> {
    vec![
        BuildFile {
            path: "index.html",
            manifest_hash: H1,
        },
        BuildFile {
            path: "assets/app.css",
            manifest_hash: H2,
        },
    ]
}

fn modules() -> Vec<BuildModule<'static>> {
    vec![
        BuildModule {
            name: "worker/index.js",
            sha256: M1,
        },
        BuildModule {
            name: "worker/lib.mjs",
            sha256: M2,
        },
    ]
}

fn code_inputs<'a>(files: &'a [BuildFile<'a>], modules: &'a [BuildModule<'a>]) -> BuildInputs<'a> {
    BuildInputs {
        commit: COMMIT,
        tree: TREE,
        files,
        modules,
        main: Some("worker/index.js"),
        store: true,
    }
}

fn static_inputs<'a>(files: &'a [BuildFile<'a>]) -> BuildInputs<'a> {
    BuildInputs {
        commit: COMMIT,
        tree: TREE,
        files,
        modules: &[],
        main: None,
        store: false,
    }
}

// --- the canonical text ------------------------------------------------------------------------------------------------

#[test]
fn the_build_text_is_the_plans_form_line_for_line() {
    let f = files();
    let m = modules();
    let text = build_text(&UPLOAD_FORM, &code_inputs(&f, &m)).unwrap();
    let expected = format!(
        "podster-build/1\n\
         form 2026-11-01 {} STORE application/javascript+module\n\
         commit {COMMIT}\n\
         tree {TREE}\n\
         file assets/app.css {H2}\n\
         file index.html {H1}\n\
         module worker/index.js {M1}\n\
         module worker/lib.mjs {M2}\n\
         main worker/index.js\n\
         store yes\n",
        podster_core::app_code::ASSETS_CONFIG
    );
    assert_eq!(text, expected);
}

#[test]
fn a_static_build_says_no_main_and_no_store() {
    let f = files();
    let text = build_text(&UPLOAD_FORM, &static_inputs(&f)).unwrap();
    assert!(text.ends_with("main -\nstore no\n"), "{text}");
    assert!(!text.contains("module "));
}

#[test]
fn the_upload_form_is_podsters_constants() {
    assert_eq!(
        UPLOAD_FORM.compatibility_date,
        podster_core::app_code::COMPATIBILITY_DATE
    );
    assert_eq!(
        UPLOAD_FORM.assets_config,
        podster_core::app_code::ASSETS_CONFIG
    );
    assert_eq!(
        UPLOAD_FORM.store_binding_name,
        podster_core::app_code::STORE_BINDING_NAME
    );
    assert_eq!(
        UPLOAD_FORM.module_upload_type,
        podster_core::app_code::MODULE_UPLOAD_TYPE
    );
}

// --- the build ID ------------------------------------------------------------------------------------------------------

#[test]
fn a_build_id_is_bld_and_32_lower_case_hexadecimal_characters() {
    let f = files();
    let m = modules();
    let id = build_id(&code_inputs(&f, &m)).unwrap();
    assert!(is_build_id(&id), "{id}");
    assert_eq!(id.len(), 36);
    assert!(id.starts_with("bld_"));
    for bad in [
        "",
        "bld_",
        "bld_0123456789abcdef0123456789abcde",
        "bld_0123456789abcdef0123456789abcdef0",
        "bld_0123456789ABCDEF0123456789abcdef",
        "BLD_0123456789abcdef0123456789abcdef",
        "rel_0123456789abcdef0123456789abcdef",
        "bld-0123456789abcdef0123456789abcdef",
        " bld_0123456789abcdef0123456789abcdef",
        "bld_0123456789abcdef0123456789abcdeg",
    ] {
        assert!(!is_build_id(bad), "{bad:?}");
    }
}

#[test]
fn a_known_build_has_a_known_id() {
    // The SHA-256 of exactly the text above, so a change to the form, its order or the hash is seen here.
    let f = files();
    let m = modules();
    let text = build_text(&UPLOAD_FORM, &code_inputs(&f, &m)).unwrap();
    let id = build_id(&code_inputs(&f, &m)).unwrap();
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(id, format!("bld_{}", &hex[..32]));
}

#[test]
fn podsters_marker_is_left_out_and_order_doesnt_matter() {
    let mut f = files();
    let m = modules();
    let base = build_id(&code_inputs(&f, &m)).unwrap();
    f.push(BuildFile {
        path: MARKER_PATH,
        manifest_hash: H1,
    });
    assert_eq!(build_id(&code_inputs(&f, &m)).unwrap(), base);
    f.reverse();
    let mut m2 = m.clone();
    m2.reverse();
    assert_eq!(build_id(&code_inputs(&f, &m2)).unwrap(), base);
}

#[test]
fn every_part_of_the_build_changes_its_id() {
    let f = files();
    let m = modules();
    let base = build_id(&code_inputs(&f, &m)).unwrap();
    let other_commit = "1123456789abcdef0123456789abcdef01234567";
    let other_hash = "10112233445566778899aabbccddeeff";
    let other_module = "1000000000000000000000000000000000000000000000000000000000000001";
    let mut changed = vec![
        build_id(&BuildInputs {
            commit: other_commit,
            ..code_inputs(&f, &m)
        }),
        build_id(&BuildInputs {
            tree: other_commit,
            ..code_inputs(&f, &m)
        }),
        build_id(&BuildInputs {
            store: false,
            ..code_inputs(&f, &m)
        }),
        build_id(&BuildInputs {
            main: Some("worker/lib.mjs"),
            ..code_inputs(&f, &m)
        }),
    ];
    let mut f2 = f.clone();
    f2[0].manifest_hash = other_hash;
    changed.push(build_id(&code_inputs(&f2, &m)));
    let mut f3 = f.clone();
    f3[0].path = "index2.html";
    changed.push(build_id(&code_inputs(&f3, &m)));
    changed.push(build_id(&code_inputs(&f[..1], &m)));
    let mut m2 = m.clone();
    m2[1].sha256 = other_module;
    changed.push(build_id(&code_inputs(&f, &m2)));
    let mut m3 = m.clone();
    m3[1].name = "worker/lib2.mjs";
    changed.push(build_id(&code_inputs(&f, &m3)));
    // Podster's own upload form: a new compatibility date between preview and publish is a new build.
    let form = UploadFormVersion {
        compatibility_date: "2026-12-01",
        ..UPLOAD_FORM
    };
    changed.push(build_id_with_form(&form, &code_inputs(&f, &m)));
    for form in [
        UploadFormVersion {
            assets_config: "{}",
            ..UPLOAD_FORM
        },
        UploadFormVersion {
            store_binding_name: "DB",
            ..UPLOAD_FORM
        },
        UploadFormVersion {
            module_upload_type: "text/javascript",
            ..UPLOAD_FORM
        },
    ] {
        changed.push(build_id_with_form(&form, &code_inputs(&f, &m)));
    }
    let mut seen = std::collections::BTreeSet::new();
    seen.insert(base.clone());
    for id in changed {
        let id = id.unwrap();
        assert!(seen.insert(id.clone()), "{id} repeats another build's ID");
    }
}

#[test]
fn a_build_whose_parts_arent_their_forms_has_no_id() {
    let f = files();
    let m = modules();
    fn refused(inputs: BuildInputs) -> BuildRefusal {
        build_id(&inputs).unwrap_err()
    }
    assert_eq!(
        refused(BuildInputs {
            commit: "abc",
            ..code_inputs(&f, &m)
        }),
        BuildRefusal::Commit
    );
    assert_eq!(
        refused(BuildInputs {
            commit: COMMIT.to_uppercase().as_str(),
            ..code_inputs(&f, &m)
        }),
        BuildRefusal::Commit
    );
    assert_eq!(
        refused(BuildInputs {
            tree: "",
            ..code_inputs(&f, &m)
        }),
        BuildRefusal::Tree
    );
    for (path, hash, why) in [
        ("", H1, BuildRefusal::Path),
        ("a/../b", H1, BuildRefusal::Path),
        ("a\nfile b", H1, BuildRefusal::Path),
        ("index.html", "00112233", BuildRefusal::ManifestHash),
        (
            "index.html",
            "00112233445566778899AABBCCDDEEFF",
            BuildRefusal::ManifestHash,
        ),
        ("index.html", M1, BuildRefusal::ManifestHash),
    ] {
        let one = [BuildFile {
            path,
            manifest_hash: hash,
        }];
        assert_eq!(
            build_id(&static_inputs(&one)).unwrap_err(),
            why,
            "{path:?} {hash:?}"
        );
    }
    let twice = [
        BuildFile {
            path: "a.html",
            manifest_hash: H1,
        },
        BuildFile {
            path: "a.html",
            manifest_hash: H2,
        },
    ];
    assert_eq!(
        build_id(&static_inputs(&twice)).unwrap_err(),
        BuildRefusal::DuplicatePath
    );
    for (name, hash, why) in [
        ("worker/a b.js", M1, BuildRefusal::ModuleName),
        ("", M1, BuildRefusal::ModuleName),
        ("worker/index.js", H1, BuildRefusal::ModuleHash),
        (
            "worker/index.js",
            "AB".repeat(32).as_str(),
            BuildRefusal::ModuleHash,
        ),
    ] {
        let one = [BuildModule { name, sha256: hash }];
        let inputs = BuildInputs {
            main: Some(name),
            ..code_inputs(&f, &one)
        };
        assert_eq!(build_id(&inputs).unwrap_err(), why, "{name:?}");
    }
    let dup = [
        BuildModule {
            name: "worker/index.js",
            sha256: M1,
        },
        BuildModule {
            name: "worker/index.js",
            sha256: M2,
        },
    ];
    assert_eq!(
        refused(code_inputs(&f, &dup)),
        BuildRefusal::DuplicateModule
    );
    // The entry must be one of the modules; a build with modules has an entry; a static build has neither, nor a store.
    assert_eq!(
        refused(BuildInputs {
            main: Some("worker/other.js"),
            ..code_inputs(&f, &m)
        }),
        BuildRefusal::Main
    );
    assert_eq!(
        refused(BuildInputs {
            main: None,
            ..code_inputs(&f, &m)
        }),
        BuildRefusal::Main
    );
    assert_eq!(
        refused(BuildInputs {
            main: Some("worker/index.js"),
            ..static_inputs(&f)
        }),
        BuildRefusal::Main
    );
    assert_eq!(
        refused(BuildInputs {
            store: true,
            ..static_inputs(&f)
        }),
        BuildRefusal::Store
    );
    // A form part holding a line break could run into the next line, so it is no form.
    let form = UploadFormVersion {
        compatibility_date: "2026-11-01\ncommit x",
        ..UPLOAD_FORM
    };
    assert_eq!(
        build_id_with_form(&form, &static_inputs(&f)).unwrap_err(),
        BuildRefusal::Form
    );
    // A space would let one part run into the next on the form's line, so it is no form either.
    for part in ["2026 11 01", " 2026-11-01", "2026-11-01\t", ""] {
        let form = UploadFormVersion {
            compatibility_date: part,
            ..UPLOAD_FORM
        };
        assert_eq!(
            build_id_with_form(&form, &static_inputs(&f)).unwrap_err(),
            BuildRefusal::Form,
            "{part:?}"
        );
    }
    for form in [
        UploadFormVersion {
            store_binding_name: "STORE X",
            ..UPLOAD_FORM
        },
        UploadFormVersion {
            module_upload_type: "application/javascript +module",
            ..UPLOAD_FORM
        },
        UploadFormVersion {
            assets_config: "{\"a\": 1}",
            ..UPLOAD_FORM
        },
    ] {
        assert_eq!(
            build_id_with_form(&form, &static_inputs(&f)).unwrap_err(),
            BuildRefusal::Form
        );
    }
    for refusal in BuildRefusal::ALL {
        assert!(refusal.code().starts_with("build_"), "{refusal:?}");
    }
}

/// Random builds: the ID never depends on the order files and modules came in, and two builds whose canonical texts
/// differ never share an ID in thousands of tries (SHA-256 truncated to 128 bits; no collision is expected).
#[test]
fn property_ids_follow_the_canonical_text_and_nothing_else() {
    let mut seed = 0x5eed_b01d_u64;
    let mut next = move || {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        seed >> 17
    };
    let paths: Vec<String> = (0..40).map(|i| format!("p/{i}.html")).collect();
    let hashes: Vec<String> = (0..40).map(|i| format!("{i:032x}")).collect();
    let mut ids = std::collections::BTreeMap::new();
    for _ in 0..3_000 {
        let n = (next() % 6) as usize;
        let mut chosen: Vec<usize> = (0..n).map(|_| (next() % 40) as usize).collect();
        chosen.sort_unstable();
        chosen.dedup();
        let mut built: Vec<BuildFile> = chosen
            .iter()
            .map(|&i| BuildFile {
                path: &paths[i],
                manifest_hash: &hashes[(i + (next() % 3) as usize) % 40],
            })
            .collect();
        let text = build_text(&UPLOAD_FORM, &static_inputs(&built)).unwrap();
        let id = build_id(&static_inputs(&built)).unwrap();
        // Any order gives the same text and ID.
        built.reverse();
        assert_eq!(
            build_text(&UPLOAD_FORM, &static_inputs(&built)).unwrap(),
            text
        );
        assert_eq!(build_id(&static_inputs(&built)).unwrap(), id);
        if let Some(previous) = ids.insert(id.clone(), text.clone()) {
            assert_eq!(previous, text, "two texts share {id}");
        }
    }
}

// --- the publish binding (decision 259) --------------------------------------------------------------------------------

fn served_preview(build: &'static str) -> PreviewReleaseRecord<'static> {
    PreviewReleaseRecord {
        environment: Environment::Preview,
        release_id: PREVIEW_ID,
        task_id: "tsk_1",
        commit_sha: COMMIT,
        state: ReleaseState::Served,
        served_at: Some(1_000),
        build_id: Some(build),
    }
}

const BUILD_B: &str = "bld_0000000000000000000000000000000b";
const BUILD_A: &str = "bld_0000000000000000000000000000000a";

#[test]
fn a_publish_names_a_preview_release_that_reached_served_with_its_build() {
    let record = served_preview(BUILD_B);
    let source = publish_source(&record, "tsk_1", COMMIT).unwrap();
    assert_eq!(source.preview_release_id, PREVIEW_ID);
    assert_eq!(source.build_id, BUILD_B);
    assert_eq!(source.commit_sha, COMMIT);
    // Still a source after the preview was replaced or deleted: that build was tested (decision 259).
    for state in [ReleaseState::Replaced, ReleaseState::Unpublished] {
        let later = PreviewReleaseRecord { state, ..record };
        assert_eq!(
            publish_source(&later, "tsk_1", COMMIT).map(|s| s.build_id),
            Ok(BUILD_B)
        );
    }
}

#[test]
fn a_publish_from_anything_but_a_served_preview_build_of_that_task_and_commit_is_refused() {
    let record = served_preview(BUILD_B);
    assert_eq!(
        publish_source(
            &PreviewReleaseRecord {
                environment: Environment::Production,
                ..record
            },
            "tsk_1",
            COMMIT
        ),
        Err(PreviewPublishRefusal::NotPreview)
    );
    for state in ReleaseState::ALL {
        let reached = matches!(
            state,
            ReleaseState::Served | ReleaseState::Replaced | ReleaseState::Unpublished
        );
        let result = publish_source(&PreviewReleaseRecord { state, ..record }, "tsk_1", COMMIT);
        assert_eq!(result.is_ok(), reached, "{state:?}");
        if !reached {
            assert_eq!(result, Err(PreviewPublishRefusal::NotServed), "{state:?}");
        }
    }
    assert_eq!(
        publish_source(
            &PreviewReleaseRecord {
                served_at: None,
                ..record
            },
            "tsk_1",
            COMMIT
        ),
        Err(PreviewPublishRefusal::NotServed)
    );
    assert_eq!(
        publish_source(
            &PreviewReleaseRecord {
                build_id: None,
                ..record
            },
            "tsk_1",
            COMMIT
        ),
        Err(PreviewPublishRefusal::NoBuild)
    );
    assert_eq!(
        publish_source(
            &PreviewReleaseRecord {
                build_id: Some("bld_x"),
                ..record
            },
            "tsk_1",
            COMMIT
        ),
        Err(PreviewPublishRefusal::NoBuild)
    );
    assert_eq!(
        publish_source(&record, "tsk_2", COMMIT),
        Err(PreviewPublishRefusal::TaskMismatch)
    );
    assert_eq!(
        publish_source(&record, "tsk_1", "1123456789abcdef0123456789abcdef01234567"),
        Err(PreviewPublishRefusal::CommitMismatch)
    );
    for refusal in PreviewPublishRefusal::ALL {
        assert!(!refusal.code().is_empty());
    }
}

#[test]
fn an_approval_is_valid_only_for_its_releases_own_build() {
    // A release made from a preview: the approver must send exactly its build.
    assert_eq!(approval_build(Some(BUILD_B), Some(BUILD_B)), Ok(()));
    assert_eq!(
        approval_build(Some(BUILD_B), Some(BUILD_A)),
        Err(ApprovalBuildRefusal::BuildChanged)
    );
    assert_eq!(
        ApprovalBuildRefusal::BuildChanged.code(),
        "release_build_changed"
    );
    assert_eq!(
        approval_build(Some(BUILD_B), None),
        Err(ApprovalBuildRefusal::BuildRequired)
    );
    assert_eq!(
        approval_build(Some(BUILD_B), Some("")),
        Err(ApprovalBuildRefusal::BuildChanged)
    );
    // A release not made from a preview takes no body, as now.
    // Equal but malformed is still no build: the form is checked, not only equality.
    for malformed in [
        "bld_x",
        "",
        "BLD_0000000000000000000000000000000B",
        "bld_0000000000000000000000000000000B",
    ] {
        assert_eq!(
            approval_build(Some(malformed), Some(malformed)),
            Err(ApprovalBuildRefusal::BuildChanged),
            "{malformed:?}"
        );
    }
    assert_eq!(approval_build(None, None), Ok(()));
    assert_eq!(
        approval_build(None, Some(BUILD_B)),
        Err(ApprovalBuildRefusal::BodyNotTaken)
    );
    assert_eq!(
        ApprovalBuildRefusal::BuildRequired.code(),
        "invalid_argument"
    );
    assert_eq!(
        ApprovalBuildRefusal::BodyNotTaken.code(),
        "invalid_argument"
    );
}

/// Decision 259: replacing the preview doesn't move a pending approval. The approval is checked against the build the
/// production release recorded from its own preview release, which nothing changes; the slot's current build is never
/// an input, so a replacement's build is refused and the original still approves.
#[test]
fn replacing_the_preview_never_moves_a_pending_approval() {
    let published_from = served_preview(BUILD_B);
    let pending = publish_source(&published_from, "tsk_1", COMMIT).unwrap();
    // The preview is replaced by a build of another commit: B's record is now replaced, A's is served.
    let replaced = PreviewReleaseRecord {
        state: ReleaseState::Replaced,
        ..published_from
    };
    let _now_serving = served_preview(BUILD_A);
    assert_eq!(publish_source(&replaced, "tsk_1", COMMIT).unwrap(), pending);
    assert_eq!(
        approval_build(Some(pending.build_id), Some(BUILD_A)),
        Err(ApprovalBuildRefusal::BuildChanged)
    );
    assert_eq!(
        approval_build(Some(pending.build_id), Some(BUILD_B)),
        Ok(())
    );
}

#[test]
fn the_production_job_goes_live_only_on_the_recorded_build() {
    assert_eq!(publish_build_check(BUILD_B, BUILD_B), Ok(()));
    assert_eq!(publish_build_check(BUILD_B, BUILD_A), Err(BuildMismatch));
    assert_eq!(BuildMismatch.code(), "build_mismatch");
    // A malformed ID on either side is never a match, even equal to itself.
    assert_eq!(publish_build_check("bld_x", "bld_x"), Err(BuildMismatch));
    assert_eq!(publish_build_check("", ""), Err(BuildMismatch));
}
