#!/usr/bin/env python3
"""Build the pinned Apple Silicon qpdf sidecar without system installation.

Run from any directory. Python 3.9+, macOS command-line developer tools and an
internet connection for first download are required. All writes stay in this
project. Use --test to also build and run qpdf's upstream default test suite.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import urllib.request

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
TOOLS = ROOT / "tools/native-engine"
CACHE = ROOT / "tmp/native-engine"
ASSETS = [
    ("cmake-4.4.3-macos-universal.tar.gz", "https://github.com/Kitware/CMake/releases/download/v4.4.3/cmake-4.4.3-macos-universal.tar.gz", "0c5d65251c14cc884bfa16bdbed3c263ce5bffe2e21c0d0d00962cb0610464fa"),
    ("libjpeg-turbo-3.2.0.tar.gz", "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.0/libjpeg-turbo-3.2.0.tar.gz", "6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e"),
    ("qpdf-12.4.1.tar.gz", "https://github.com/qpdf/qpdf/releases/download/v12.4.1/qpdf-12.4.1.tar.gz", "f045aa277be2356ff53a89a8622945958291177d2483afc20ede7c8a8cd3873c"),
]


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(*args, cwd=ROOT):
    print("Running:", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)


def extract(archive, destination, prefix=""):
    """Copy verified source/CLI regular files; reject unsafe paths/links."""
    with tarfile.open(archive) as tar:
        for entry in tar.getmembers():
            if prefix and not entry.name.startswith(prefix):
                continue
            name = entry.name[len(prefix):] if prefix else entry.name
            rel = Path(name)
            if not name or any(part.startswith("._") for part in rel.parts):
                continue
            if rel.is_absolute() or ".." in rel.parts:
                raise RuntimeError("Unsafe archive path: " + name)
            if prefix and rel.parts[0] not in ("bin", "share"):
                continue
            if prefix and rel.parts[0] == "bin" and len(rel.parts) > 1 and rel.name not in ("cmake", "ctest", "cpack", "ccmake"):
                continue
            target = destination / rel
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif entry.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(entry) as src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
                target.chmod(entry.mode)
            elif entry.issym() or entry.islnk():
                # None of the required source/CLI files are symlinks.
                raise RuntimeError("Unexpected archive link: " + name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    options = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This build script targets Apple Silicon macOS only.")
    TOOLS.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    os.environ["TMPDIR"] = str(CACHE)
    for name, url, expected in ASSETS:
        archive = CACHE / name
        if not archive.exists():
            partial = archive.with_suffix(archive.suffix + ".download")
            print("Downloading", url, flush=True)
            urllib.request.urlretrieve(url, partial)
            if sha256(partial) != expected:
                raise RuntimeError("Checksum mismatch: " + name)
            partial.replace(archive)
        if sha256(archive) != expected:
            raise RuntimeError("Cached checksum mismatch: " + name)
        if name.startswith("cmake-"):
            if not (TOOLS / "cmake-cli/bin/cmake").exists():
                extract(archive, TOOLS / "cmake-cli", "cmake-4.4.3-macos-universal/CMake.app/Contents/")
        elif not (TOOLS / name.removesuffix(".tar.gz")).exists():
            extract(archive, TOOLS)

    # exFAT exposes macOS AppleDouble metadata as ._ files. CMake's upstream
    # compiler-module glob includes them; filter only those non-module files.
    # Extracting a plain CLI tree avoids macOS App Management bundle protection.
    module = TOOLS / "cmake-cli/share/cmake-4.4/Modules/CMakeCompilerIdDetection.cmake"
    original = "function(_readFile file)\n  include(${file})"
    fixed = 'function(_readFile file)\n  get_filename_component(_pdfwb_name "${file}" NAME)\n  if(_pdfwb_name MATCHES "^[.][_]")\n    return()\n  endif()\n  include(${file})'
    text = module.read_text()
    if original in text:
        module.write_text(text.replace(original, fixed))

    cmake = TOOLS / "cmake-cli/bin/cmake"
    common = ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"]
    run(cmake, "-S", TOOLS / "libjpeg-turbo-3.2.0", "-B", TOOLS / "jpeg-build", *common,
        "-DCMAKE_INSTALL_PREFIX=" + str(TOOLS / "jpeg-install"), "-DENABLE_SHARED=OFF", "-DENABLE_STATIC=ON", "-DWITH_TOOLS=OFF", "-DWITH_TESTS=OFF", "-DWITH_TURBOJPEG=OFF")
    run(cmake, "--build", TOOLS / "jpeg-build", "--parallel", "6")
    run(cmake, "--install", TOOLS / "jpeg-build")
    run(cmake, "-S", TOOLS / "qpdf-12.4.1", "-B", TOOLS / "qpdf-build", *common,
        "-DBUILD_SHARED_LIBS=OFF", "-DBUILD_STATIC_LIBS=ON", "-DUSE_IMPLICIT_CRYPTO=OFF", "-DREQUIRE_CRYPTO_NATIVE=ON", "-DBUILD_DOC=OFF",
        "-DCMAKE_PREFIX_PATH=" + str(TOOLS / "jpeg-install"), "-DCMAKE_INSTALL_PREFIX=" + str(TOOLS / "qpdf-install"))
    run(cmake, "--build", TOOLS / "qpdf-build", "--parallel", "6", "--target", "qpdf")
    if options.test:
        run(cmake, "--build", TOOLS / "qpdf-build", "--parallel", "6")
        run(TOOLS / "cmake-cli/bin/ctest", "--output-on-failure", cwd=TOOLS / "qpdf-build")

    sidecar = APP / "src-tauri/binaries/qpdf-aarch64-apple-darwin"
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TOOLS / "qpdf-build/qpdf/qpdf", sidecar)
    sidecar.chmod(0o755)
    notices = APP / "notices"
    notices.mkdir(exist_ok=True)
    for src, dest in [
        ("qpdf-12.4.1/LICENSE.txt", "qpdf-LICENSE.txt"),
        ("qpdf-12.4.1/NOTICE.md", "qpdf-NOTICE.md"),
        ("libjpeg-turbo-3.2.0/LICENSE.md", "libjpeg-turbo-LICENSE.md"),
        ("libjpeg-turbo-3.2.0/README.ijg", "libjpeg-turbo-README.ijg"),
    ]:
        shutil.copyfile(TOOLS / src, notices / dest)
    run(sidecar, "--version", cwd=CACHE)
    run("otool", "-L", sidecar)
    manifest = {
        "schemaVersion": 1, "qpdf": "12.4.1", "libjpegTurbo": "3.2.0", "cmake": "4.4.3",
        "platform": platform.platform(), "target": "aarch64-apple-darwin", "macosDeploymentTarget": "12.0",
        "linkage": "static qpdf and libjpeg; system zlib/libc++/libSystem", "crypto": "native",
        "sidecarSha256": sha256(sidecar), "sidecarBytes": sidecar.stat().st_size,
        "archives": [{"name": n, "url": u, "sha256": s} for n, u, s in ASSETS],
    }
    (APP / "docs/native-engine-build.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
