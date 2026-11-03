#!/bin/zsh
set -euo pipefail
script_dir="${0:A:h}"
app_root="${script_dir:h}"
repo_root="${app_root:h:h}"
build_root="${WEEKLY_REPORT_BUILD_DIR:-$repo_root/.local/weekly-report/DerivedData}"
configuration="${WEEKLY_REPORT_CONFIGURATION:-Debug}"
reader_target="$repo_root/.local/weekly-report/reader-target"
if command -v cargo >/dev/null 2>&1; then
  CARGO_TARGET_DIR="$reader_target" cargo build --locked --manifest-path "$app_root/Reader/Cargo.toml"
else
  task_runtime="$repo_root/.local/collector-probe/rustup/toolchains/stable-aarch64-apple-darwin/bin"
  CARGO_HOME="$repo_root/.local/collector-probe/cargo" RUSTC="$task_runtime/rustc" CARGO_TARGET_DIR="$reader_target" "$task_runtime/cargo" build --locked --offline --manifest-path "$app_root/Reader/Cargo.toml"
fi
mkdir -p "$app_root/Resources/Reader"
cp "$reader_target/debug/cc-session-reader" "$app_root/Resources/Reader/cc-session-reader"
swift "$script_dir/prepare-assets.swift" "$repo_root" "$app_root/Resources/Assets.xcassets"
xcodegen generate --spec "$app_root/project.yml" --project "$app_root"
# Ad-hoc bundles have no Team ID for hardened library validation.
xcodebuild -project "$app_root/WeeklyReport.xcodeproj" -scheme WeeklyReport -configuration "$configuration" -derivedDataPath "$build_root" -destination 'platform=macOS' CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES ENABLE_HARDENED_RUNTIME=NO build "$@"
print "Built: $build_root/Build/Products/$configuration/weekly report.app"
