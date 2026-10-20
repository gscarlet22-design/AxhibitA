#!/usr/bin/env bash
# Generate the synthetic signed-video fixtures used by the e2e test:
#   tests/fixtures/media/signed.mkv    test pattern, signed with a throwaway test key
#   tests/fixtures/media/tampered.mkv  the same, with one byte flipped inside the 5th GOP
# No camera footage is involved. Linux/WSL only (needs sv-sign from scripts/build-native.sh,
# openssl, python3 and an ffmpeg with an H.264 encoder).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIGN="$ROOT/native/sv-tool/sv-sign"
OUT="$ROOT/tests/fixtures/media"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -x "$SIGN" ] || bash "$ROOT/scripts/build-native.sh"
mkdir -p "$OUT"

# throwaway EC P-256 key: test signatures only, never a camera key
openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/key.pem"

# 10 s test pattern, 15 fps, a keyframe every second, no B-frames (as Axis cameras stream)
ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=15:duration=10 \
  -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -g 15 -keyint_min 15 -sc_threshold 0 -bf 0 \
  -bsf:v h264_mp4toannexb -f h264 "$TMP/plain.h264"

"$SIGN" --codec h264 --key "$TMP/key.pem" < "$TMP/plain.h264" > "$TMP/signed.h264"

# flip one byte well inside the slice data of the 5th IDR frame (GOP 4)
python3 - "$TMP/signed.h264" "$TMP/tampered.h264" <<'PY'
import sys
data = bytearray(open(sys.argv[1], 'rb').read())
idr, i = 0, 0
while i < len(data) - 4:
    if data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 1:
        if data[i + 3] & 0x1F == 5:
            idr += 1
            if idr == 5:
                data[i + 200] ^= 0x01
                break
        i += 3
    else:
        i += 1
else:
    sys.exit('fewer than 5 IDR frames')
open(sys.argv[2], 'wb').write(data)
PY

for n in signed tampered; do
  ffmpeg -nostdin -hide_banner -loglevel error -y -r 15 -i "$TMP/$n.h264" -c copy "$OUT/$n.mkv"
done
echo "wrote $OUT/signed.mkv and $OUT/tampered.mkv"
