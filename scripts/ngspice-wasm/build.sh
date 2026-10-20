#!/bin/bash
# Сборка ngspice в WebAssembly для браузерной демо-версии (запускается в GitHub Actions, где есть сеть).
# Основано на сценарии EEcircuit-engine (MIT, https://github.com/eelab-dev/EEcircuit-engine):
# зеркало исходников ngspice, удаление hicum2/C++ (hicum2_patch.sh — оттуда же), флаги emcc.
# В отличие от EEcircuit, ngspice запускается в пакетном режиме (-b файл), без интерактивного ввода:
# Asyncify не нужен. Результат: vendor/ngspice-wasm/spice.js, spice.wasm, VERSION.
set -euo pipefail
trap 'echo "::error::build.sh, строка $LINENO: $BASH_COMMAND"' ERR
mkdir -p "${1:-vendor/ngspice-wasm}"
OUT="$(realpath "${1:-vendor/ngspice-wasm}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/ngspice-wasm"
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"
cd "$WORK"
git clone --depth 1 https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install 3.1.74
./emsdk/emsdk activate 3.1.74
source ./emsdk/emsdk_env.sh
git clone https://github.com/danchitnis/ngspice-sf-mirror ngspice
cd ngspice
# Проверенная версия; в новейшей метке зеркала встречаются неполные правки (cktsopt.c: OPT_ENH_RSHUNT).
tag="${NGSPICE_TAG:-ngspice-44.2}"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || tag=$(git tag | grep -E '^ngspice-[0-9]+(\.[0-9]+)?$' | sort -V | tail -n 1)
echo "::notice::ngspice: $tag; метки: $(git tag | grep -E '^ngspice-4[0-9]' | sort -V | tail -n 6 | tr '\n' ' ')"
git checkout "$tag"
bash "$HERE/hicum2_patch.sh"
sed -i 's/-Wno-unused-but-set-variable/-Wno-unused-const-variable/g' ./configure.ac
sed -i 's/AC_CHECK_FUNCS(\[time getrusage\])/AC_CHECK_FUNCS(\[time\])/g' ./configure.ac
./autogen.sh
mkdir release && cd release
emconfigure ../configure --disable-debug --disable-openmp --disable-xspice --disable-osdi --without-x --with-readline=no > configure.log 2>&1 || { tail -20 configure.log | sed "s/^/::error::/"; exit 1; }
sed -i 's|$(ngspice_LDADD) $(LIBS)|$(ngspice_LDADD) $(LIBS) -O2 -s ALLOW_MEMORY_GROWTH=1 -s MODULARIZE=1 -s EXPORT_NAME=createNgspice -s ENVIRONMENT=web,worker,node -s INVOKE_RUN=0 -s EXIT_RUNTIME=1 -s FORCE_FILESYSTEM=1 -s EXPORTED_RUNTIME_METHODS=["FS","callMain"] -o spice.js|g' ./src/Makefile
grep -q "EXPORT_NAME=createNgspice" ./src/Makefile
emmake make -j"$(nproc)" > make.log 2>&1 || { grep -m 20 -E "error" make.log | sed "s/^/::error::/"; exit 1; }
cp src/spice.js src/spice.wasm "$OUT/"
cp ../COPYING "$OUT/COPYING-ngspice" 2>/dev/null || true
echo "$tag (emscripten 3.1.74, пакетный режим)" > "$OUT/VERSION"
ls -la "$OUT"
