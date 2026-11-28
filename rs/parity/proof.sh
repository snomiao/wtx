#!/bin/sh
# Every proof that the binary behaves like wtx.mjs, in one go, on Linux,
# macOS or Windows (in Git Bash there):
#
#   sh rs/parity/proof.sh <rustify's templates/parity/parity.mjs> <the wtx binary>
#
# from the repository root or anywhere, after `bun install`. The CI
# workflow's parity job runs this on each platform of `parity-platforms`,
# against the binary it has just built for that platform ($RUSTIFY_PLATFORM
# names it; without it, `uname` does).
#
#   1. rs/parity.json is what rs/parity.gen.mjs writes, and rs/src/testdata
#      what rs/parity/record.ts records from this bun (the TypeScript's own
#      functions, which the Rust modules are tested against);
#   2. the cases of rs/parity.json, split into lanes (rs/parity/lanes.mjs)
#      that run side by side, each lane twice: wtx.mjs against the binary,
#      both behind rs/parity/drive.mjs, which starts the server on
#      127.0.0.1 and a free port, drives it over HTTP and WebSocket, stops
#      it and prints all it saw (the binary hands back to the package here,
#      WTX_PACKAGE_ROOT); then the binary alone against the runner's
#      stand-in package, which fails unless exactly the cases marked
#      "handback" for this system reach the JavaScript: today all of them,
#      on every system. PARITY_LANES lanes (3 by default: each case keeps a
#      server, its sessions and bun busy, and Windows could not start new
#      processes with 8);
#   3. cargo test in rs/: the modules against what the TypeScript answered
#      (step 1), and the hand-back helper. It builds the crate again from
#      the same sources and Cargo.lock; it does not run the binary named
#      above;
#   4. the npm package with the binary named above, as rustify's pack.mjs
#      (beside the runner: ../npm/pack.mjs, with the launcher of the same
#      templates) packs it: on Linux and macOS the cases named "v-install"
#      install it as npm would, so that the first run goes through rustify's
#      launcher (rs/parity/drive.mjs, PARITY_INSTALL; on Windows npm installs
#      a command shim, which they do not build, and they are skipped); and on
#      every system rs/parity/launcher.mjs installs it for real, with bun and
#      with npm, from a stand-in registry (../npm/registry.mjs), and compares
#      the first run and the second with wtx.mjs run directly, in 18
#      scenarios (17 on Windows): .env files, preloads of a bunfig.toml and
#      of BUN_OPTIONS, one that deletes a variable of the user's, one that
#      sets NODE_ENV, one that deletes process.versions.bun and one that puts
#      its own object in process.env's place, an empty environment,
#      RUSTIFY_NO_LINK=1, ... (see there); and in 3 of them with pnpm where
#      there is one. A launcher older than v3 fails there, and so does the
#      first cut of v3 (rustify 25ce88e), which took an empty environment,
#      or one holding a variable a preload deleted, for a wrong read and
#      passed bun's process.env on. So do rustify's templates after it and
#      before d9f603c (#57: cc50aec, a629a0a, 23f6df4): the scenarios of a
#      preload that deletes process.versions.bun (the launcher then passes
#      process.env on, .env files and all), before 23f6df4 the one of an
#      object in process.env's place that throws when asked, and on Linux
#      and macOS pnpm's second run (the launcher has put the binary where
#      pnpm's shim runs `bun <file>`); each failure says what rustify must
#      change. Give the parity.mjs of rustify's templates from d9f603c on
#      (releases/v1 since 2026-11-28), with which every scenario passes.
#      npm is the one on PATH, or PARITY_NPM_CLI (an npm-cli.js the
#      driver's runtime runs) where there is none; pnpm is PARITY_PNPM_CLI
#      (a pnpm.cjs or pnpm.mjs that bun runs), or the one on PATH on Linux
#      and macOS.
#
# There is no run on a terminal (--tty): wtx writes only to its own stdout
# and stderr, which rs/parity/drive.mjs reads through pipes, and what a
# session's program sees is a PTY of bun-pty's in either run.
#
# Each run of the runner gets a temp directory of its own (TMPDIR, and TEMP
# and TMP, which bun and node read on Windows), removed afterwards. At the
# end one line is printed for each step that passed, and all of what a
# failed one wrote. The exit code is 0 only when all of them passed.
set -u
usage="usage: proof.sh <parity.mjs> <binary>"
# In Git Bash, `pwd -W` gives a directory as Windows programs (node, the
# binary) read it, and cygpath -m one spelling (C:/…) that they and the
# shell all read alike.
here=$(pwd -W 2> /dev/null || pwd)
absolute() {
  case "$1" in
    /* | [A-Za-z]:[\\/]*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$here" "$1" ;;
  esac
}
runner=$(absolute "${1:?$usage}")
binary=$(absolute "${2:?$usage}")
if command -v cygpath > /dev/null 2>&1; then
  runner=$(cygpath -m "$runner")
  binary=$(cygpath -m "$binary")
fi
cd "$(dirname "$0")/../.." || exit 1
# The directory as the system spells it (pwd -P): the runner writes <REPO>
# for that spelling, and the binary passes WTX_PACKAGE_ROOT on as it is.
root=$(pwd -W 2> /dev/null || pwd -P)

platform=${RUSTIFY_PLATFORM:-}
if [ -z "$platform" ]; then
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    MINGW* | MSYS* | CYGWIN*) platform=win32 ;;
    *) platform=$(uname -s) ;;
  esac
fi
lanes=${PARITY_LANES:-3}

node rs/parity.gen.mjs --check || exit 1
bun rs/parity/record.ts --check || exit 1

# In $TMPDIR, which macOS's mktemp passes over without a template.
logs=$(mktemp -d "${TMPDIR:-/tmp}/wtx-proof.XXXXXX") || exit 1
spelt() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}
logs_for_node=$(spelt "$logs")
node rs/parity/lanes.mjs rs/parity.json "$lanes" "$logs_for_node" || exit 1

# rs/parity/drive.mjs and rs/parity/launcher.mjs run on node. Where `node`
# is bun (a shim, as on one Mac), bun would read the .env and bunfig.toml of
# each case's directory for the driver itself, and the driver would pass the
# .env values on to the server as real variables: so they run there without
# them.
js="node"
if node -e 'process.exit(process.versions.bun ? 0 : 1)'; then
  : > "$logs/empty-bunfig.toml"
  js="bun --no-env-file --config=$logs_for_node/empty-bunfig.toml"
fi
driver="$js rs/parity/drive.mjs"

# The package as the pipeline packs it, for the install cases (step 4).
templates=$(dirname "$runner")/../npm
key=$(node -p 'process.platform + "-" + process.arch')
exe=""
case $platform in win32*) exe=".exe" ;; esac
mkdir -p "$logs/native/$key" && cp "$binary" "$logs/native/$key/wtx$exe" || exit 1
if ! node "$templates/pack.mjs" pack --package package.json --manifest rs/Cargo.toml --artifacts "$logs/native" --out "$logs/dist" --allow-missing > "$logs/pack.log" 2>&1; then
  echo "pack: FAILED"
  cat "$logs/pack.log"
  rm -rf "$logs"
  exit 1
fi
dist_env=""
case $platform in
  win32*) ;;
  *) dist_env="PARITY_DIST=$logs_for_node/dist" ;;
esac

start() {
  name=$1
  shift
  (
    "$@" > "$logs/$name.log" 2>&1
    echo $? > "$logs/$name.exit"
  ) &
}
# One run of the runner, in a temp directory of its own. (sh has no local
# variables: each function keeps names of its own.)
run_in() {
  run_dir=$(mktemp -d "${TMPDIR:-/tmp}/wtx-run.XXXXXX") || return 1
  run_dir_for_node=$(spelt "$run_dir")
  run_code=0
  TMPDIR=$run_dir_for_node TEMP=$run_dir_for_node TMP=$run_dir_for_node node "$runner" "$@" || run_code=1
  rm -rf "$run_dir"
  return $run_code
}
# A command in a temp directory of its own (TMPDIR, TEMP and TMP).
run_in_dir() {
  own_dir=$(mktemp -d "${TMPDIR:-/tmp}/wtx-run.XXXXXX") || return 1
  own_dir_for_node=$(spelt "$own_dir")
  own_code=0
  TMPDIR=$own_dir_for_node TEMP=$own_dir_for_node TMP=$own_dir_for_node "$@" || own_code=1
  rm -rf "$own_dir"
  return $own_code
}
lane() {
  lane_cases=$logs_for_node/lane-$1.json
  lane_code=0
  run_in --cases "$lane_cases" --ts "env $dist_env $driver bun wtx.mjs" \
    --rs "env WTX_PACKAGE_ROOT=$root $dist_env $driver $binary" || lane_code=1
  run_in --cases "$lane_cases" --rs "env $dist_env $driver $binary" --handback WTX_PACKAGE_ROOT=wtx.mjs || lane_code=1
  return $lane_code
}
runs=""
n=0
while [ "$n" -lt "$lanes" ]; do
  start "lane$n" lane "$n"
  runs="$runs lane$n"
  n=$((n + 1))
done
start unit cargo test --release --locked --manifest-path rs/Cargo.toml
runs="$runs unit"
# shellcheck disable=SC2086 # $js is a command and its options
start launcher run_in_dir $js rs/parity/launcher.mjs "$logs_for_node/dist" "$(spelt "$templates")"
runs="$runs launcher"
wait

echo "proof on $platform with bun $(bun --version), $lanes lane(s):$runs"
failed=0
same=0 native=0 back=0
for name in $runs; do
  code=$(cat "$logs/$name.exit" 2> /dev/null || echo "no exit code")
  if [ "$code" != 0 ]; then
    echo "$name: FAILED ($code)"
    cat "$logs/$name.log"
    failed=1
    continue
  fi
  case $name in
    lane*)
      count=$(sed -n 's/^all \([0-9]*\) case(s) behave the same$/\1/p' "$logs/$name.log")
      same=$((same + count))
      count=$(sed -n 's/^\([0-9]*\) case(s) answered by the binary, .*/\1/p' "$logs/$name.log")
      native=$((native + count))
      count=$(sed -n 's/^.* answered by the binary, \([0-9]*\) handed back .*/\1/p' "$logs/$name.log")
      back=$((back + count))
      ;;
    unit) grep '^test result' "$logs/$name.log" | sed "s/^/$name: /" ;;
    launcher) sed "s/^/$name: /" "$logs/$name.log" ;;
  esac
done
if [ "$failed" = 0 ]; then
  echo "parity: all $same case(s) behave the same; $native answered by the binary, $back handed back to the JavaScript, as the cases say"
  # Each run of each lane names the cases skipped here, and why (both runs
  # of a lane skip the same ones): the reasons, summed.
  tab=$(printf '\t')
  cat "$logs"/lane*.log | sed -n "s/^ *\([0-9][0-9]*\)  \(.*\)\$/\1$tab\2/p" | sort -t "$tab" -k 2 | awk -F "$tab" '
    $2 != reason { if (reason != "") print total "\t" reason; reason = $2; total = 0 }
    { total += $1 }
    END { if (reason != "") print total "\t" reason }' | while IFS="$tab" read -r total reason; do
    echo "  skipped on $platform: $((total / 2))  $reason"
  done
fi
rm -rf "$logs"
exit $failed
