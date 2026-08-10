#!/usr/bin/env bash
#
# Remove host-coupled graphics libraries from a built AppImage, repack it in
# place, and prove they are gone.
#
# tauri-bundler runs linuxdeploy, which copies libwayland-client.so.0 and
# friends out of the build machine into the AppImage. On a host whose Mesa is
# newer than the builder's, that older bundled copy shadows the host one and
# host libEGL then fails eglGetPlatformDisplay with EGL_BAD_PARAMETER: WebKit's
# WebProcess aborts and the window comes up blank while the GTK shell survives.
# These libraries are on the AppImageCommunity/pkg2appimage excludelist
# precisely because they must come from the host. See #498, and #499 for the
# investigation that isolated libwayland-client.so.0 as necessary and
# sufficient. (#463 fixed a separate WebKitGTK version pin.)
#
# This lives in a script rather than inline in build.yml for two reasons. It is
# the step that failed in two of the three v2.7.2 release attempts, and an
# inline heredoc can only be exercised by cutting a release. And the excludelist
# below is the one place that names these libraries, so a test can read it.
#
# Signing is deliberately NOT done here. tauri build already signed the
# pre-strip file and that signature no longer matches, so the caller must
# re-sign — but keeping the key out of this script is what lets anyone run it on
# a downloaded AppImage without one.
#
# Usage: scripts/strip-appimage.sh <path-to.AppImage>

set -euo pipefail

APPIMAGE="${1:-}"
if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
	echo "usage: $0 <path-to.AppImage>" >&2
	exit 2
fi
APPIMAGE=$(realpath "$APPIMAGE")

# Host-coupled graphics libraries. libwayland-client.so.0 is the one that
# actually breaks EGL; the rest belong to the host graphics stack for the same
# reason and are on the same excludelist.
EXCLUDED=(
	libwayland-client.so.0
	libwayland-cursor.so.0
	libwayland-egl.so.1
	libwayland-server.so.0
	libxcb-render.so.0
	libxcb-shm.so.0
)

APPIMAGETOOL_URL=${APPIMAGETOOL_URL:-https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage}
RUNTIME_URL=${RUNTIME_URL:-https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64}

tools=$(mktemp -d)
work=$(mktemp -d)
check=$(mktemp -d)
trap 'rm -rf "$tools" "$work" "$check"' EXIT

echo "Repackaging $APPIMAGE"

# --appimage-extract and appimagetool's --appimage-extract-and-run both unpack
# without libfuse2, which the GitHub runner does not have.
wget -q "$APPIMAGETOOL_URL" -O "$tools/appimagetool"
wget -q "$RUNTIME_URL" -O "$tools/runtime-x86_64"
chmod +x "$tools/appimagetool"

( cd "$work" && "$APPIMAGE" --appimage-extract >/dev/null )
libdir="$work/squashfs-root/usr/lib"

for lib in "${EXCLUDED[@]}"; do
	rm -fv "$libdir/$lib"
done

# Repack in place so the file name — which is also the updater target named in
# latest.json — is unchanged.
ARCH=x86_64 "$tools/appimagetool" --appimage-extract-and-run \
	--runtime-file "$tools/runtime-x86_64" \
	"$work/squashfs-root" "$APPIMAGE"

# Assert the property on the artifact that ships, not on the AppDir it was
# built from. A CI smoke test cannot catch this defect at all — the runner's
# Mesa is the one the libraries came from, so nothing mismatches there — which
# leaves "these libraries are absent" as the only thing that can actually be
# checked before a user on a newer distro finds out.
( cd "$check" && "$APPIMAGE" --appimage-extract >/dev/null )
failed=0
for lib in "${EXCLUDED[@]}"; do
	if [ -e "$check/squashfs-root/usr/lib/$lib" ]; then
		echo "::error::$lib is still bundled after the strip" >&2
		failed=1
	fi
done
[ "$failed" -eq 0 ] || exit 1

echo "Repacked without ${#EXCLUDED[@]} host-coupled libraries:"
ls -la "$APPIMAGE"
