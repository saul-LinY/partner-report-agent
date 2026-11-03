#!/bin/zsh
set -euo pipefail
script_dir="${0:A:h}"
app_root="${script_dir:h}"
repo_root="${app_root:h:h}"
build_root="${WEEKLY_REPORT_BUILD_DIR:-$repo_root/.local/weekly-report/DerivedData}"
configuration="${WEEKLY_REPORT_CONFIGURATION:-Release}"
account="com.weeklyreport.desktop.updates"

# The bundled Rust reader is built for the current host architecture.
WEEKLY_REPORT_CONFIGURATION="$configuration" "$script_dir/build.sh" ARCHS="$(uname -m)"
app="$build_root/Build/Products/$configuration/weekly report.app"
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")
public_key=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$app/Contents/Info.plist")
tools="$build_root/SourcePackages/artifacts/sparkle/Sparkle/bin"
if [[ "$("$tools/generate_keys" --account "$account" -p)" != "$public_key" ]]; then
  print -u2 "The Keychain signing key does not match the app's update public key."
  exit 1
fi

tag="macos-v$version"
output="$repo_root/.local/weekly-report/releases/$tag-$build"
archive="$output/weekly-report-$version-$build.zip"
if [[ -e "$output" ]]; then
  print -u2 "Release output already exists: $output. Increase the build number before packaging again."
  exit 1
fi
mkdir -p "$output"
/usr/bin/codesign --verify --deep --strict "$app"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
"$tools/generate_appcast" --account "$account" --maximum-deltas 0 \
  --download-url-prefix "https://github.com/saul-LinY/partner-report-agent/releases/download/$tag/" \
  "$output"
"$tools/sign_update" --account "$account" "$output/appcast.xml"
"$tools/sign_update" --account "$account" --verify "$output/appcast.xml"
print "Archive: $archive"
print "Appcast: $output/appcast.xml"
print "Release tag: $tag"
print "Publish the archive as a GitHub release, then copy appcast.xml to apps/macos/appcast.xml and commit it."
