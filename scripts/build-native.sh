#!/usr/bin/env bash
# Build the signed-video validator (sv-validate) for Linux (tests) and Windows x64 (shipped).
# Requires: meson, ninja, gcc, mingw-w64, and a static OpenSSL for mingw in native/win/openssl-win
#   (see docs/ARCHITECTURE.md → Signed video (native)).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVF="$ROOT/native/signed-video-framework"
OSSL="$ROOT/native/win/openssl-win"
INC="-I$SVF/lib/src/includes"

if [ ! -d "$SVF/lib" ]; then
  git clone https://github.com/AxisCommunications/signed-video-framework.git "$SVF"
  git -C "$SVF" checkout 0feb08799f53917e352573b9eb66ee199ba3186e
  git -C "$SVF" submodule update --init --depth 1
fi

# --- Linux (for tests) ---
if [ ! -f "$SVF/build-linux/libsigned-video-framework.a" ]; then
  meson setup "$SVF/build-linux" "$SVF" -Dstaticlibrary=true --buildtype=release
  ninja -C "$SVF/build-linux"
fi
gcc -O2 -o "$ROOT/native/sv-tool/sv-validate" "$ROOT/native/sv-tool/sv_tool.c" $INC "$SVF/build-linux/libsigned-video-framework.a" -lcrypto
gcc -O2 -DSV_TOOL_SIGN -o "$ROOT/native/sv-tool/sv-sign" "$ROOT/native/sv-tool/sv_tool.c" $INC "$SVF/build-linux/libsigned-video-framework.a" -lcrypto

# --- Windows x64 (shipped) ---
cat > "$ROOT/native/win/cross-mingw64.txt" <<EOF
[binaries]
c = 'x86_64-w64-mingw32-gcc'
ar = 'x86_64-w64-mingw32-ar'
strip = 'x86_64-w64-mingw32-strip'
pkg-config = 'pkg-config'
windres = 'x86_64-w64-mingw32-windres'

[properties]
pkg_config_libdir = '$OSSL/lib/pkgconfig'

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
if [ ! -f "$SVF/build-win/libsigned-video-framework.a" ]; then
  PKG_CONFIG_LIBDIR="$OSSL/lib/pkgconfig" meson setup "$SVF/build-win" "$SVF" --cross-file "$ROOT/native/win/cross-mingw64.txt" \
    -Dstaticlibrary=true --buildtype=release -Dwerror=false
  ninja -C "$SVF/build-win"
fi
x86_64-w64-mingw32-gcc -O2 -static -o "$ROOT/resources/bin/sv-validate.exe" "$ROOT/native/sv-tool/sv_tool.c" $INC -I"$OSSL/include" \
  "$SVF/build-win/libsigned-video-framework.a" "$OSSL/lib/libcrypto.a" -lws2_32 -lcrypt32 -lbcrypt -luser32 -ladvapi32
x86_64-w64-mingw32-strip "$ROOT/resources/bin/sv-validate.exe"
mkdir -p "$ROOT/resources/bin/LICENSES"
cp "$SVF/LICENSE" "$ROOT/resources/bin/LICENSES/signed-video-framework-MIT.txt"
cp "$SVF/media-signing-framework/LICENSE" "$ROOT/resources/bin/LICENSES/media-signing-framework-MIT.txt"
cp "$ROOT/native/win/openssl-3.0.15/LICENSE.txt" "$ROOT/resources/bin/LICENSES/OpenSSL-Apache-2.0.txt"
echo "built resources/bin/sv-validate.exe"
