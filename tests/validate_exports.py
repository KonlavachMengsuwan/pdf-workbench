#!/usr/bin/env python3
"""Validate app-generated PDFs using pypdf, Pillow and independent Poppler.

First run npm test to create ../tmp/test-results/*.pdf, then run this script.
Pass --pdftoppm /absolute/path/to/pdftoppm or set PDFWORKBENCH_PDFTOPPM.
Only generated fixtures and test-results inside this project are accessed.
"""
from pathlib import Path
from collections import Counter
from PIL import Image, ImageChops, ImageStat
from pypdf import PdfReader
import argparse
import hashlib
import io
import json
import os
import platform
import shutil
import subprocess
import time
from xml.sax.saxutils import escape

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
FIXTURES = ROOT / "test-data"
OUT = ROOT / "tmp/test-results"
RENDERS = OUT / "renders"
QPDF = APP / "src-tauri/binaries/qpdf-aarch64-apple-darwin"
REPORT = {"schemaVersion": 1, "status": "running", "checks": [], "renderComparisons": [], "files": {}}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check(condition, name, **evidence):
    REPORT["checks"].append({"name": name, "passed": bool(condition), **evidence})
    if not condition:
        raise AssertionError(name)


def command(*args):
    env = os.environ.copy()
    env["TMPDIR"] = str(OUT)
    env["XDG_CACHE_HOME"] = str(ROOT / "cache/validation")
    env["FONTCONFIG_FILE"] = str(OUT / "fonts.conf")
    env["FONTCONFIG_PATH"] = str(OUT)
    process = subprocess.run(list(map(str, args)), cwd=OUT, env=env, capture_output=True, check=True, timeout=120)
    return process.stdout


def box(rect):
    return [float(x) for x in rect]


def near(actual, expected):
    return len(actual) == len(expected) and all(abs(a-b) < 0.02 for a, b in zip(actual, expected))


def image_signature(image):
    return (image.width, image.height, digest(image.convert("RGBA").tobytes()))


def object_value(value):
    return value.get_object() if hasattr(value, "get_object") else value


def images(page):
    return sorted(image_signature(entry.image) for entry in page.images)


def fonts(page):
    resource = object_value(page.get("/Resources", {}))
    found = []
    for ref in resource.get("/Font", {}).get_object().values() if resource.get("/Font") else []:
        font = ref.get_object()
        descriptor = object_value(font.get("/FontDescriptor", {}))
        embedded = []
        for name in ("/FontFile", "/FontFile2", "/FontFile3"):
            if name in descriptor:
                embedded.append((name, digest(descriptor[name].get_object().get_data())))
        unicode_map = digest(font["/ToUnicode"].get_object().get_data()) if "/ToUnicode" in font else None
        found.append((str(font.get("/BaseFont")), str(font.get("/Subtype")), tuple(embedded), unicode_map))
    return sorted(found)


def same_resources(path, mapping, source):
    reader = PdfReader(path)
    check(len(reader.pages) == len(mapping), path.name + ": expected page count", pages=len(reader.pages))
    for index, source_index in enumerate(mapping):
        page, original = reader.pages[index], source.pages[source_index]
        prefix = path.name + ": page " + str(index+1)
        check(page.extract_text() == original.extract_text(), prefix + " selectable text retained")
        check(fonts(page) == fonts(original), prefix + " font programs and Unicode maps retained")
        check(images(page) == images(original), prefix + " decoded image pixels unchanged")
    REPORT["files"][path.name] = {"bytes": path.stat().st_size, "sha256": digest(path.read_bytes()), "pages": len(reader.pages),
                                "mediaBoxes": [box(p.mediabox) for p in reader.pages], "cropBoxes": [box(p.cropbox) for p in reader.pages],
                                "rotations": [p.rotation for p in reader.pages]}
    return reader


def render(pdftoppm, path):
    directory = RENDERS / path.stem
    directory.mkdir(parents=True, exist_ok=True)
    command(pdftoppm, "-r", "96", "-cropbox", "-png", path, directory / "page")
    outputs = sorted(p for p in directory.glob("page-*.png") if not p.name.startswith("._"))
    check(len(outputs) == len(PdfReader(path).pages), path.name + ": independent renderer produced every page")
    for output in outputs:
        with Image.open(output) as image:
            check(image.width > 0 and image.height > 0, output.parent.name + "/" + output.name + ": nonempty rendered dimensions")
    return outputs


def compare_pixels(left, right, name):
    with Image.open(left) as a, Image.open(right) as b:
        check(a.size == b.size, name + ": rendered dimensions match")
        difference = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
        extrema = difference.getextrema()
        maximum = max(value[1] for value in extrema)
        mean = sum(ImageStat.Stat(difference).mean)/3
        REPORT["renderComparisons"].append({"name": name, "maximumChannelDifference": maximum, "meanChannelDifference": mean,
                                            "left": str(left.relative_to(ROOT)), "right": str(right.relative_to(ROOT))})
        check(maximum == 0, name + ": exact independent rendered pixel equality", maximumDifference=maximum)


def verify_fixture_features():
    check(bool(PdfReader(FIXTURES/"bookmarks.pdf").outline), "bookmark fixture contains real outline entries")
    check(any(page.get("/Annots") for page in PdfReader(FIXTURES/"links.pdf").pages), "link fixture contains annotations")
    check(bool(PdfReader(FIXTURES/"forms.pdf").get_fields()), "form fixture contains interactive fields")
    check(bool(PdfReader(FIXTURES/"attachments.pdf").attachments), "attachment fixture contains embedded files")
    check("/StructTreeRoot" in PdfReader(FIXTURES/"tags.pdf").trailer["/Root"], "tag fixture contains structure root")
    check(any(field.get("/FT") == "/Sig" for field in PdfReader(FIXTURES/"signature-field.pdf").get_fields().values()), "signature fixture contains signature field")
    encrypted = PdfReader(FIXTURES/"encrypted.pdf")
    check(encrypted.is_encrypted, "encrypted fixture is encrypted")
    check(bool(encrypted.decrypt("test-password")), "encrypted fixture opens with known test password")
    mixed = PdfReader(FIXTURES/"mixed-rotation-crop.pdf")
    check(any(page.rotation for page in mixed.pages), "mixed fixture has existing rotation")
    check(any(box(page.cropbox) != box(page.mediabox) for page in mixed.pages), "mixed fixture has an existing crop")


def validate(pdftoppm):
    manifest = json.loads((FIXTURES/"manifest.json").read_text())
    for name, expected in manifest.items():
        check(digest((FIXTURES/name).read_bytes()) == expected["sha256"], "original fixture hash before tests: " + name)
    verify_fixture_features()
    source_path = FIXTURES / "studio-sample.pdf"
    source = PdfReader(source_path)
    REPORT["engines"] = {"python": platform.python_version(), "pypdf": __import__("pypdf").__version__, "pillow": Image.__version__,
                         "qpdf": command(QPDF, "--version").decode().splitlines()[0],
                         "pdftoppm": subprocess.run([pdftoppm, "-v"], capture_output=True, text=True).stderr.splitlines()[0]}
    geometry = {}
    for name in ["rotated", "cropped", "fit-letter", "stretch", "bounds"]:
        geometry[name] = same_resources(OUT/(name+".pdf"), range(4), source)
        command(QPDF, "--check", OUT/(name+".pdf"))
    check(geometry["rotated"].pages[0].rotation == 90, "rotation export is 90 degrees")
    check(geometry["cropped"].pages[1].rotation == 270, "crop export second page rotation is 270 degrees")
    cropped = geometry["cropped"].pages[0]
    check(near(box(cropped.cropbox), [22,30,549.28,781.89]), "crop preserves requested asymmetric margins")
    hidden_text = []
    def visitor(text, cm, tm, font, fontsize):
        if text.strip() and (tm[4] < float(cropped.cropbox.left) or tm[4] > float(cropped.cropbox.right) or tm[5] < float(cropped.cropbox.bottom) or tm[5] > float(cropped.cropbox.top)):
            hidden_text.append(text.strip())
    cropped.extract_text(visitor_text=visitor)
    check(bool(hidden_text), "crop retains selectable text outside visible CropBox (not redaction)", hiddenText=hidden_text)
    check(near(box(geometry["fit-letter"].pages[0].mediabox), [0,0,612,792]), "fit creates Letter paper")
    for name in ("stretch", "bounds"):
        check(near(box(geometry[name].pages[0].mediabox), [0,0,420,600]), name + " creates explicit requested paper")
    check(geometry["stretch"].pages[0].get_contents().get_data() != geometry["bounds"].pages[0].get_contents().get_data(), "stretch and paper-only resize produce different content operations")
    blank = PdfReader(OUT/"blank-mixed.pdf")
    check(len(blank.pages) == 2 and near(box(blank.pages[0].mediabox), [0,0,612,792]) and near(box(blank.pages[1].mediabox), [0,0,400,500]), "blank pages preserve mixed paper choices")
    check(all(not page.extract_text() and not list(page.images) for page in blank.pages), "blank pages contain no unexpected text or images")
    converted = PdfReader(OUT/"images.pdf")
    check(len(converted.pages) == 2, "image conversion creates two pages")
    for page, extension in zip(converted.pages, ("png", "jpg")):
        with Image.open(FIXTURES/("chart."+extension)) as expected:
            if extension == "jpg":
                # pypdf's page.images convenience conversion re-encodes JPEG.
                # Decode the original DCT stream itself for a lossless check.
                xobjects = page["/Resources"]["/XObject"].get_object()
                jpeg_streams = [ref.get_object().get_data() for ref in xobjects.values() if ref.get_object().get("/Filter") == "/DCTDecode"]
                check(len(jpeg_streams) == 1 and jpeg_streams[0] == (FIXTURES/"chart.jpg").read_bytes(), "JPEG compressed data embedded byte-for-byte")
                with Image.open(io.BytesIO(jpeg_streams[0])) as embedded:
                    check(image_signature(embedded) == image_signature(expected), "image conversion preserves JPG decoded samples")
            else:
                check(images(page) == [image_signature(expected)], "image conversion preserves " + extension.upper() + " decoded samples")
            check(near(box(page.mediabox), [0,0,expected.width,expected.height]), extension + " conversion preserves image dimensions as PDF points")
    # Native page operations are independently checked against their input page
    # resources and text, rather than trusting an engine's success exit status.
    command(QPDF, "--empty", "--pages", source_path, "3,1,1,4", "--", OUT/"reordered.pdf")
    same_resources(OUT/"reordered.pdf", [2,0,0,3], source)
    command(QPDF, "--empty", "--pages", source_path, "2-3", "--", OUT/"extracted.pdf")
    same_resources(OUT/"extracted.pdf", [1,2], source)
    for filename in ("split-1.pdf", "split-2.pdf", "split-3.pdf", "split-4.pdf"):
        previous = OUT/filename
        if previous.exists(): previous.unlink()
    command(QPDF, "--split-pages", source_path, OUT/"split.pdf")
    for number in range(1,5):
        same_resources(OUT/("split-"+str(number)+".pdf"), [number-1], source)
    command(QPDF, source_path, OUT/"optimized.pdf", "--object-streams=generate", "--recompress-flate", "--compression-level=9")
    same_resources(OUT/"optimized.pdf", range(4), source)
    REPORT["optimization"] = {"beforeBytes": source_path.stat().st_size, "afterBytes": (OUT/"optimized.pdf").stat().st_size,
                              "changeBytes": (OUT/"optimized.pdf").stat().st_size-source_path.stat().st_size}
    render_paths = [source_path] + [OUT/(name+".pdf") for name in ("rotated", "cropped", "fit-letter", "stretch", "bounds", "blank-mixed", "images", "reordered", "extracted", "optimized")]
    rendered = {path.stem: render(pdftoppm, path) for path in render_paths}
    for index in range(4):
        compare_pixels(rendered["studio-sample"][index], rendered["optimized"][index], "optimization page " + str(index+1))
    for index, original in enumerate([2,0,0,3]):
        compare_pixels(rendered["studio-sample"][original], rendered["reordered"][index], "reordered page " + str(index+1))
    with Image.open(rendered["stretch"][0]) as stretch, Image.open(rendered["bounds"][0]) as bounds:
        check(ImageChops.difference(stretch.convert("RGB"), bounds.convert("RGB")).getbbox() is not None, "independent renderer confirms stretch and paper-only resize are visually distinct")
    for name, expected in manifest.items():
        check(digest((FIXTURES/name).read_bytes()) == expected["sha256"], "original fixture hash after tests: " + name)
    REPORT["renderedPageCount"] = sum(map(len, rendered.values()))
    REPORT["limitations"] = ["This controlled fixture suite does not establish complete fidelity for arbitrary PDFs.", "Signed, tagged, form, bookmark and attachment fixtures test detection/protection elsewhere; they are not modified here.", "Windows has not been run."]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdftoppm", default=os.environ.get("PDFWORKBENCH_PDFTOPPM") or shutil.which("pdftoppm"))
    args = parser.parse_args()
    if not args.pdftoppm:
        raise SystemExit("Pass --pdftoppm with the path to an available Poppler renderer.")
    OUT.mkdir(parents=True, exist_ok=True)
    RENDERS.mkdir(exist_ok=True)
    font_cache = ROOT / "cache/validation/fontconfig"
    font_cache.mkdir(parents=True, exist_ok=True)
    # Bundled fontconfig's generic macOS config scans Assets/AssetsV2, which can
    # create thousands of cache files. Keep this validation profile explicit.
    font_directory = "/System/Library/Fonts" if platform.system() == "Darwin" else os.environ.get("PDFWORKBENCH_TEST_FONTS", "/usr/share/fonts")
    (OUT / "fonts.conf").write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>' + escape(font_directory) + '</dir><cachedir>' + escape(str(font_cache)) + '</cachedir></fontconfig>')
    start = time.perf_counter()
    try:
        validate(args.pdftoppm)
        REPORT["status"] = "passed"
    except Exception as error:
        REPORT["status"] = "failed"
        REPORT["error"] = str(error)
        raise
    finally:
        REPORT["elapsedSeconds"] = round(time.perf_counter()-start,3)
        REPORT["passedChecks"] = sum(item["passed"] for item in REPORT["checks"])
        (OUT/"validation.json").write_text(json.dumps(REPORT, indent=2) + "\n")
        print(json.dumps({key:REPORT[key] for key in ("status","passedChecks","elapsedSeconds")}, indent=2))


if __name__ == "__main__":
    main()
