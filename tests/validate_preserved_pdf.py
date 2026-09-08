#!/usr/bin/env python3
"""Independently validate an already exported PDF; no PDF is modified.

Examples (angles are relative, margins use the original unrotated MediaBox):
  python3 tests/validate_preserved_pdf.py --source input.pdf --output copy.pdf \
    --rotate 1:90 --crop 2:12,18,20,24 --pdftoppm /path/to/pdftoppm
  python3 tests/validate_preserved_pdf.py --source input.pdf --output editing.pdf \
    --editing-copy --pdftoppm /path/to/pdftoppm

Reports/renders are written under this project's tmp directory only. The
source/candidate PDF bytes and decoded JSON are never copied into Git.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import json
import math
import os
import platform
import subprocess
import time
from xml.sax.saxutils import escape

from PIL import Image, ImageChops
from pypdf import PdfReader
from preservation_graph import compare
from validate_exports import fonts, images

ROOT = Path(__file__).resolve().parents[2]
QPDF = ROOT / "app/src-tauri/binaries/qpdf-aarch64-apple-darwin"
PROTECTED_KEYS = {"/AcroForm", "/XFA", "/Annots", "/Outlines", "/StructTreeRoot",
                  "/MarkInfo", "/RoleMap", "/StructParents", "/StructParent", "/Metadata",
                  "/Names", "/Dests", "/Dest", "/OpenAction", "/AA", "/JS", "/JavaScript",
                  "/PageLabels", "/ByteRange", "/Perms", "/EmbeddedFiles", "/AF", "/Collection",
                  "/OCProperties", "/OutputIntents", "/Threads", "/PieceInfo"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(*args, env=None):
    return subprocess.run(list(map(str, args)), check=True, capture_output=True, timeout=120, env=env)


def graph(path):
    if path.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("This validation CLI is bounded to 100 MiB input files.")
    run(QPDF, "--check", path)
    raw = run(QPDF, "--json-output=2", "--json-stream-data=inline", "--decode-level=generalized", path).stdout
    if len(raw) > 256 * 1024 * 1024:
        raise ValueError("Decoded JSON exceeds this validator's 256 MiB bound.")
    return json.loads(raw)


def page_reference(page):
    ref = page.indirect_reference
    if ref is None:
        raise ValueError("A page has no indirect reference; this verifier cannot map it safely.")
    return f"{ref.idnum} {ref.generation} R"


def destination_snapshot(reader):
    return sorted((name, reader.get_destination_page_number(dest),
                   [(key, str(value)) for key, value in dest.items() if key != "/Page"])
                  for name, dest in reader.named_destinations.items())


def outline_snapshot(reader):
    result = []
    def walk(items, depth=0):
        for entry in items:
            if isinstance(entry, list):
                walk(entry, depth + 1)
            else:
                result.append((depth, str(entry.title), reader.get_destination_page_number(entry),
                               [(key, str(value)) for key, value in entry.items() if key not in ("/Page", "/%is_open%")]))
    walk(reader.outline)
    return result


def feature_keys(value):
    found = set()
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            found.update(set(item) & PROTECTED_KEYS)
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    return found


def editing_page_graph(data, reader, expected_removals):
    """Compare page/resource graphs, intentionally excluding document features."""
    normalized = copy.deepcopy(data)
    objects = normalized["qpdf"][1]
    objects["trailer"]["value"] = {"pagesForComparison": [page_reference(page) for page in reader.pages]}
    # Page-only copying can flatten standard inherited attributes. Materialize
    # their effective values on both sides before disconnecting the page tree.
    for page in reader.pages:
        value = objects["obj:"+page_reference(page)]["value"]
        for key in ("/MediaBox", "/CropBox", "/Rotate", "/Resources"):
            node, seen = value, set()
            while key not in node and "/Parent" in node:
                reference = node["/Parent"]
                if reference in seen:
                    raise ValueError("A cyclic page tree cannot be normalized safely.")
                seen.add(reference)
                node = objects["obj:"+reference]["value"]
            if key in node:
                value[key] = copy.deepcopy(node[key])
    for wrapper in objects.values():
        value = wrapper.get("value", wrapper.get("stream", {}).get("dict", {}))
        if not isinstance(value, dict):
            continue
        if expected_removals:
            for key in ("/Metadata", "/StructParent", "/StructParents", "/Tabs"):
                value.pop(key, None)
        if value.get("/Type") == "/Page":
            value.pop("/Parent", None)
            if expected_removals:
                value.pop("/Annots", None)
    return normalized


def parse_changes(values, count, crop=False):
    parsed = {}
    for value in values:
        page_text, data_text = value.split(":", 1)
        page = int(page_text)
        if page < 1 or page > count or page in parsed:
            raise ValueError("Geometry page number is duplicated or outside the document.")
        if crop:
            data = tuple(float(part) for part in data_text.split(","))
            if len(data) != 4 or any(not math.isfinite(x) or x < 0 for x in data):
                raise ValueError("Crop requires four finite nonnegative left,right,top,bottom margins.")
        else:
            data = int(data_text)
            if data % 90:
                raise ValueError("Rotation must be a multiple of 90 degrees.")
        parsed[page - 1] = data
    return parsed


def validate(args, report, record):
    source_path, output_path = args.source.resolve(), args.output.resolve()
    if os.path.samefile(source_path, output_path):
        raise ValueError("Source and exported output must be different files.")
    source_sha, output_sha = digest(source_path.read_bytes()), digest(output_path.read_bytes())
    source, output = PdfReader(source_path), PdfReader(output_path)
    record(len(source.pages) == len(output.pages), "same complete page sequence length")
    if len(source.pages) > 100:
        raise ValueError("This renderer validation is bounded to 100 pages.")
    rotations = parse_changes(args.rotate, len(source.pages))
    crops = parse_changes(args.crop, len(source.pages), crop=True)
    before, after = graph(source_path), graph(output_path)
    allowed = {}
    for index, (old_page, new_page) in enumerate(zip(source.pages, output.pages)):
        rules = {}
        if index in rotations:
            expected = (old_page.rotation + rotations[index]) % 360
            record(new_page.rotation == expected, f"page {index+1}: requested rotation applied", expected=expected)
            rules["/Rotate"] = expected
        else:
            record(old_page.rotation == new_page.rotation, f"page {index+1}: rotation unchanged")
        if index in crops:
            left, right, top, bottom = crops[index]
            box = list(map(float, old_page.mediabox))
            expected = [box[0]+left, box[1]+bottom, box[2]-right, box[3]-top]
            if expected[2] <= expected[0] or expected[3] <= expected[1]:
                raise ValueError("Requested crop leaves no visible page.")
            actual = list(map(float, new_page.cropbox))
            record(all(abs(a-b) <= 1e-6 for a, b in zip(expected, actual)), f"page {index+1}: requested crop applied", expected=expected, actual=actual)
            # Tolerate only verified sub-micro-point decimal serialization.
            candidate_page = after["qpdf"][1]["obj:"+page_reference(new_page)]["value"]
            rules["/CropBox"] = candidate_page["/CropBox"]
        if rules:
            allowed[page_reference(old_page)] = rules
        record(old_page.extract_text() == new_page.extract_text(), f"page {index+1}: selectable text preserved")
        record(fonts(old_page) == fonts(new_page), f"page {index+1}: font programs and Unicode maps preserved")
        record(images(old_page) == images(new_page), f"page {index+1}: decoded image samples preserved")

    if args.editing_copy:
        remaining = sorted(feature_keys(after["qpdf"][1]))
        record(not remaining, "editing copy contains none of the disclosed removed features", remaining=remaining)
        before = editing_page_graph(before, source, True)
        after = editing_page_graph(after, output, False)
    else:
        record(destination_snapshot(source) == destination_snapshot(output), "named destination names, targets and coordinates preserved")
        record(outline_snapshot(source) == outline_snapshot(output), "bookmark hierarchy, targets and coordinates preserved")
        record(source.page_labels == output.page_labels, "page labels preserved")
        record([len(page.get("/Annots", [])) for page in source.pages] == [len(page.get("/Annots", [])) for page in output.pages], "annotation counts per page preserved")
    comparison = compare(before, after, allowed)
    report["graph"] = comparison
    record(comparison["equivalent"], "reachable graph and decoded streams match approved changes")

    directory = args.report.parent / (args.report.stem + "-renders")
    directory.mkdir(parents=True, exist_ok=True)
    cache = ROOT / "cache/preservation-validation/fontconfig"
    cache.mkdir(parents=True, exist_ok=True)
    font_directory = os.environ.get("PDFWORKBENCH_TEST_FONTS", "/System/Library/Fonts" if platform.system() == "Darwin" else "/usr/share/fonts")
    config = directory / "fonts.conf"
    config.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>'+escape(font_directory)+'</dir><cachedir>'+escape(str(cache))+'</cachedir></fontconfig>')
    env = os.environ.copy()
    env.update({"FONTCONFIG_FILE": str(config), "FONTCONFIG_PATH": str(directory), "XDG_CACHE_HOME": str(cache.parent), "TMPDIR": str(directory)})
    rendered = {}
    for name, path in [("source", source_path), ("output", output_path)]:
        folder = directory / name
        folder.mkdir(exist_ok=True)
        # A later run can have fewer pages; stale validator-owned renders must
        # never be mistaken for output from the current renderer invocation.
        for previous in folder.glob("page-*.png"):
            previous.unlink()
        run(args.pdftoppm, "-r", "96", "-cropbox", "-png", path, folder/"page", env=env)
        rendered[name] = sorted(p for p in folder.glob("page-*.png") if not p.name.startswith("._"))
        record(len(rendered[name]) == len(source.pages), name + ": every page rendered independently")
    exact_pages = 0
    for index, (left, right) in enumerate(zip(rendered["source"], rendered["output"])):
        with Image.open(left) as a, Image.open(right) as b:
            if index not in rotations and index not in crops:
                record(a.size == b.size, f"page {index+1}: rendered dimensions unchanged")
                maximum = max(high for low, high in ImageChops.difference(a.convert("RGB"), b.convert("RGB")).getextrema())
                record(maximum == 0, f"page {index+1}: exact independent rendered pixel equality", maximumChannelDifference=maximum)
                exact_pages += 1
            else:
                page = output.pages[index]
                width, height = float(page.cropbox.width), float(page.cropbox.height)
                if page.rotation % 180:
                    width, height = height, width
                expected = (math.ceil(width*96/72), math.ceil(height*96/72))
                record(b.size == expected, f"page {index+1}: rendered dimensions match requested geometry", expected=expected, actual=b.size)
    record(digest(source_path.read_bytes()) == source_sha, "source SHA256 unchanged during validation")
    record(digest(output_path.read_bytes()) == output_sha, "output SHA256 unchanged during validation")
    report.update({"sourceSha256": source_sha, "outputSha256": output_sha,
                   "sourceBytes": source_path.stat().st_size, "outputBytes": output_path.stat().st_size,
                   "pageCount": len(source.pages), "renderedPageCount": len(source.pages)*2,
                   "exactPixelComparisonPages": exact_pages, "editingCopy": args.editing_copy,
                   "sourceSemanticCounts": {"namedDestinations": len(source.named_destinations),
                                            "outlineEntries": len(outline_snapshot(source)),
                                            "annotations": sum(len(page.get("/Annots", [])) for page in source.pages)},
                   "limitations": ["Controlled preservation verification, not PDF conformance or signature validation.",
                                   "Geometry-changed pages receive graph/resource/text and rendered-dimension checks; exact pixels are compared only where geometry is unchanged."]})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rotate", action="append", default=[], metavar="PAGE:DEGREES")
    parser.add_argument("--crop", action="append", default=[], metavar="PAGE:LEFT,RIGHT,TOP,BOTTOM")
    parser.add_argument("--editing-copy", action="store_true")
    parser.add_argument("--pdftoppm", required=True)
    parser.add_argument("--report", type=Path, default=ROOT/"tmp/test-results/preserved-pdf-validation.json")
    args = parser.parse_args()
    args.report = args.report.resolve()
    if not args.report.is_relative_to(ROOT/"tmp"):
        parser.error("Validation reports/renders must remain under the project's tmp directory.")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": 1, "status": "running", "checks": []}
    def record(ok, name, **evidence):
        report["checks"].append({"name": name, "passed": bool(ok), **evidence})
        if not ok:
            raise AssertionError(name)
    start = time.perf_counter()
    try:
        validate(args, report, record)
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        report["elapsedSeconds"] = round(time.perf_counter()-start, 3)
        report["passedChecks"] = sum(item["passed"] for item in report["checks"])
        args.report.write_text(json.dumps(report, indent=2)+"\n")
        print(json.dumps({key: report[key] for key in ("status", "passedChecks", "elapsedSeconds")}, indent=2))


if __name__ == "__main__":
    main()
