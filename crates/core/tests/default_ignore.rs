//! The default `.gitignore` a new managed repository starts with is Runner's own default ignore list, line for line.
use podster_core::provisioning::DEFAULT_IGNORE;

/// Reads `WORK_TREE_DEFAULT_IGNORE` out of Runner's source, so the two lists can't drift apart unnoticed.
#[test]
fn the_seeded_list_is_runners_work_tree_default_ignore() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/runner/src/core/repository.ts"
    );
    let source = std::fs::read_to_string(path).unwrap_or_default();
    let start = "export const WORK_TREE_DEFAULT_IGNORE = [";
    let list = source
        .split_once(start)
        .and_then(|(_, rest)| rest.split_once("] as const;"))
        .map(|(list, _)| list)
        .unwrap_or_default();
    let runner: Vec<&str> = list
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.trim_end_matches(',').trim_matches('"'))
        .collect();
    assert!(!runner.is_empty(), "Runner's list wasn't found in {path}");
    assert_eq!(runner, DEFAULT_IGNORE);
}
