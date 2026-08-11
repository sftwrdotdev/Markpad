#!/usr/bin/env bash
#
# Ask a freshly built AppImage which host-coupled libraries linuxdeploy put in
# it, and require the answer to be exactly the list strip-appimage.sh removes.
#
# strip-appimage.sh already proves its six are gone afterwards. That is "we
# removed what we meant to remove"; it cannot say whether six is still the right
# number. #463 and #498 were both a library that had to come from the host being
# bundled anyway, and the second was found by a user on Arch weeks after release.
#
# What decides the answer is not in this repository. `tauri build` fetches
# linuxdeploy-plugin-gtk from the tip of someone else's branch on every run --
#
#   Downloading https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh
#
# -- so the set of libraries copied into the AppDir can change with no commit
# here, no pull request, and no notification. That is the same shape as a runner
# image moving under `macos-latest`, one repository further away.
#
# Run against the AppImage a pull request builds, which is the un-stripped one:
# for this question that is the right artifact, not a worse one. It shows what
# linuxdeploy actually did before anything was taken back out.
#
# The authority on "must come from the host" is the AppImage project's own
# excludelist, fetched rather than vendored. It growing is the signal we want,
# and a copy here would be a second place to keep current. A failed fetch is a
# failed check, never a pass.
#
# Usage: scripts/check-appimage-libraries.sh <path-to.AppImage>

set -euo pipefail

APPIMAGE="${1:-}"
if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
	echo "usage: $0 <path-to.AppImage>" >&2
	exit 2
fi
APPIMAGE=$(realpath "$APPIMAGE")
HERE=$(cd "$(dirname "$0")" && pwd)

EXCLUDELIST_URL=${EXCLUDELIST_URL:-https://raw.githubusercontent.com/AppImageCommunity/pkg2appimage/master/excludelist}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The strip list has one home, and this is not it -- read it out of the script
# that acts on it rather than keeping a second copy in step.
mapfile -t stripped < <(
	sed -n '/^EXCLUDED=(/,/^)/p' "$HERE/strip-appimage.sh" |
		grep -oE '\blib[A-Za-z0-9_.+-]*\.so\.[0-9]+' | sort -u
)
if [ "${#stripped[@]}" -eq 0 ]; then
	echo "::error::found no EXCLUDED entries in strip-appimage.sh; this check has nothing to compare against" >&2
	exit 1
fi

curl -fsSL --max-time 60 "$EXCLUDELIST_URL" -o "$work/excludelist"
grep -oE '^[A-Za-z0-9_.+-]+\.so[.0-9]*' "$work/excludelist" | sort -u >"$work/must-come-from-host"
if [ ! -s "$work/must-come-from-host" ]; then
	echo "::error::$EXCLUDELIST_URL answered, but with no library names in it" >&2
	exit 1
fi

( cd "$work" && "$APPIMAGE" --appimage-extract >/dev/null )
find "$work/squashfs-root" -name '*.so*' -printf '%f\n' | sort -u >"$work/bundled"

comm -12 "$work/bundled" "$work/must-come-from-host" >"$work/host-coupled"
printf '%s\n' "${stripped[@]}" | sort -u >"$work/expected"

echo "Bundled libraries the excludelist says must come from the host:"
sed 's/^/  /' "$work/host-coupled"

appeared=$(comm -23 "$work/host-coupled" "$work/expected")
vanished=$(comm -13 "$work/host-coupled" "$work/expected")

status=0
if [ -n "$appeared" ]; then
	echo "::error::linuxdeploy bundled a host-coupled library strip-appimage.sh does not remove:" >&2
	printf '  %s\n' $appeared >&2
	echo "::error::this is the shape of #463 and #498. Add it to EXCLUDED in scripts/strip-appimage.sh, or explain why it is safe to bundle." >&2
	status=1
fi
if [ -n "$vanished" ]; then
	echo "::error::strip-appimage.sh removes a library nothing bundles any more:" >&2
	printf '  %s\n' $vanished >&2
	echo "::error::drop it from EXCLUDED so the list keeps describing what is actually there." >&2
	status=1
fi

[ "$status" -eq 0 ] && echo "The ${#stripped[@]} libraries strip-appimage.sh removes are exactly the ones bundled."
exit "$status"
