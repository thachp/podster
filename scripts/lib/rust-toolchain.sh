# Sourced, not run: puts the Rust toolchain rust-toolchain.toml pins first on PATH, so the API's Wasm build gets it and
# not whichever rustc and cargo come first, such as Homebrew's, which has no wasm32-unknown-unknown target.
# Used by scripts/deploy-staging and scripts/with-pinned-rust. It installs nothing.

# pinned_rust_first ROOT: when rustup is on PATH, asks it, from ROOT, for the pinned toolchain's rustc and puts that
# folder (rustc, cargo and the rest) first on PATH. RUSTUP_AUTO_INSTALL=0 stops rustup installing a missing toolchain:
# that fails instead, with pinned_rust_problem saying what to run. Without rustup, PATH is left as it is, and
# rustc_builds_wasm decides.
pinned_rust_first() {
  local root=$1 rustc_path
  pinned_rust_problem=""
  command -v rustup > /dev/null 2>&1 || return 0
  if ! rustc_path=$(cd "$root" && RUSTUP_AUTO_INSTALL=0 rustup which rustc 2> /dev/null) || ! [ -x "$rustc_path" ]; then
    pinned_rust_problem="rustup has no toolchain installed for $root/rust-toolchain.toml. From the repository, run: rustup toolchain install"
    return 1
  fi
  PATH="$(dirname "$rustc_path"):$PATH"
  export PATH
}

# rustc_builds_wasm: the first rustc on PATH has the wasm32-unknown-unknown target's libraries. rustc is asked where
# they are, and the folder must exist: Homebrew's rustc names the folder and exits 0 though it has none.
rustc_builds_wasm() {
  local libs
  libs=$(rustc --print target-libdir --target wasm32-unknown-unknown 2> /dev/null) || return 1
  [ -n "$libs" ] && [ -d "$libs" ]
}
