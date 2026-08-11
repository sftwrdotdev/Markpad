#!/usr/bin/env bash
#
# Start the AppImage that is about to be released, on a distribution that is not
# the one it was built on, and fail if it does not come up.
#
# strip-appimage.sh says a CI smoke test cannot catch this defect, because the
# runner's Mesa is the one the libraries were copied from. That is true of the
# runner and only of the runner. A container carries another distribution's
# userspace on the same kernel, which is enough: #463 and #498 were both a
# bundled library shadowing a newer one on the host, and a host with a newer one
# is exactly what this rents for ninety seconds.
#
# Two things make it testable at all, and both are recorded in those issues:
# the abort happens without a GPU -- LIBGL_ALWAYS_SOFTWARE, WEBKIT_DISABLE_DMABUF_RENDERER
# and WEBKIT_DISABLE_COMPOSITING_MODE were all tried and none of them helped, so
# software rendering under Xvfb reproduces it -- and it prints the same line
# every time.
#
# That line is why "did the process survive" is not the check. #499: "the window
# comes up blank while the GTK shell survives". The main process stays up; it is
# WebKit's WebProcess that aborts. A liveness check alone would have passed
# through both defects this exists to catch.
#
# Limits, so nobody reads more into a green run than it says. The container
# shares the host kernel. One distribution is not every distribution -- it is
# the "newer than the builder" case, which is the case that broke. And it reads
# specific strings, so a reworded abort would pass; the process-death check is
# the backstop for that.
#
# Usage: scripts/smoke-appimage.sh <path-to.AppImage>
#   IMAGE          container image to run it on   (default: archlinux:latest)
#   SECONDS_TO_LIVE  how long it must stay up     (default: 25)

set -euo pipefail

APPIMAGE="${1:-}"
if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
	echo "usage: $0 <path-to.AppImage>" >&2
	exit 2
fi
APPIMAGE=$(realpath "$APPIMAGE")

IMAGE=${IMAGE:-archlinux:latest}
SECONDS_TO_LIVE=${SECONDS_TO_LIVE:-25}

echo "Starting $(basename "$APPIMAGE") on $IMAGE for ${SECONDS_TO_LIVE}s"

# `-i` with a heredoc keeps the inner script out of a quoting maze.
# APPIMAGE_EXTRACT_AND_RUN because the container has no FUSE to mount with.
docker run --rm -i \
	-v "$APPIMAGE:/tmp/Markpad.AppImage:ro" \
	-e SECONDS_TO_LIVE="$SECONDS_TO_LIVE" \
	-e APPIMAGE_EXTRACT_AND_RUN=1 \
	"$IMAGE" bash -s <<'INNER'
set -euo pipefail

pacman -Sy --noconfirm --needed xorg-server-xvfb mesa >/dev/null 2>&1

cd /tmp
cp Markpad.AppImage app.AppImage
chmod +x app.AppImage

echo "host graphics stack:"
pacman -Q mesa | sed 's/^/  /'

set +e
timeout --signal=TERM "$SECONDS_TO_LIVE" xvfb-run -a ./app.AppImage >/tmp/output 2>&1
rc=$?
set -e

echo "--- output ---"
cat /tmp/output
echo "--- exit code: $rc ---"

# `timeout` returns 124 when it had to stop the process, which is the pass: the
# app was still running when its time was up.
if [ "$rc" != "124" ]; then
	echo "::error::Markpad exited on its own after less than ${SECONDS_TO_LIVE}s (exit $rc). It should still have been running." >&2
	exit 1
fi

# The failure that does not kill the process. Both #463 and #498 printed this.
if grep -qE 'EGL_BAD_PARAMETER|Could not create default EGL display|Aborting\.\.\.' /tmp/output; then
	echo "::error::Markpad started but WebKit aborted -- the blank-window failure of #463 and #498, on a host newer than the builder." >&2
	exit 1
fi

echo "Markpad was still running after ${SECONDS_TO_LIVE}s with no abort in its output."
INNER
