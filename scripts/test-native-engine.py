#!/usr/bin/env python3
"""Independent, deterministic PDF fixture and native qpdf integration checks."""
from pathlib import Path
import hashlib
import json
import subprocess
import time

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
QPDF = APP / "src-tauri/binaries/qpdf-aarch64-apple-darwin"
OUT = ROOT / "tmp/native-engine/smoke test with spaces"


def run(*args):
    return subprocess.run([str(QPDF), *map(str, args)], cwd=OUT, check=True, capture_output=True).stdout


def inspect(path):
    return json.loads(run("--json=2", path))


def dictionary(data, ref):
    return data["qpdf"][1]["obj:" + ref]["value"]


def streams(path, data):
    return [b"".join(run("--show-object=" + ref.replace(" R", "").replace(" ", ","), "--filtered-stream-data", path)
                     for ref in page["contents"]) for page in data["pages"]]


def fixture(path):
    contents = [b"q 0.15 0.45 0.85 rg 36 36 160 90 re f Q\nBT /F1 24 Tf 36 650 Td (ALPHA selectable text) Tj ET\n" + b"\n" * 4000,
                b"q 0.8 0.3 0.1 RG 2 w 36 36 400 600 re S Q\nBT /F1 24 Tf 36 650 Td (BETA vector page) Tj ET\n"]
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R /Annots [8 0 R] >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"]
    objects.extend(b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"endstream" for data in contents)
    objects += [b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                b"<< /Type /Annot /Subtype /Link /Rect [36 640 310 682] /Border [0 0 0] /A << /S /URI /URI (https://example.com/pdf-workbench) >> >>"]
    pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf += str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 " + str(len(offsets)).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets[1:]:
        pdf += ("%010d 00000 n \n" % offset).encode()
    pdf += b"trailer\n<< /Size " + str(len(offsets)).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    path.write_bytes(pdf)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source, transformed, optimized, cropped = [OUT / name for name in ["original.pdf", "transformed.pdf", "optimized.pdf", "cropped.pdf"]]
    start = time.perf_counter()
    fixture(source)
    original_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    run("--check", source)
    before = inspect(source)
    original_streams = streams(source, before)
    run(source, "--pages", ".", "2,1,1", "--", transformed, "--rotate=+90:1")
    run("--check", transformed)
    after = inspect(transformed)
    assert len(after["pages"]) == 3
    assert dictionary(after, after["pages"][0]["object"])["/Rotate"] == 90
    assert streams(transformed, after) == [original_streams[1], original_streams[0], original_streams[0]]
    for page in after["pages"][1:]:
        annotations = dictionary(after, page["object"])["/Annots"]
        assert len(annotations) == 1
        link = dictionary(after, annotations[0])
        assert link["/Subtype"] == "/Link"
        assert link["/A"]["/URI"] == "u:https://example.com/pdf-workbench"
    run(transformed, optimized, "--object-streams=generate", "--recompress-flate", "--compression-level=9")
    run("--check", optimized)
    optimized_json = inspect(optimized)
    assert streams(optimized, optimized_json) == streams(transformed, after)
    # Exercise qpdf's object update using the JSON for this exact input.
    page_ref = optimized_json["pages"][1]["object"]
    page_value = dictionary(optimized_json, page_ref)
    page_value["/CropBox"] = [18, 24, 594, 768]
    update = {"qpdf": [{"jsonversion": 2}, {"obj:" + page_ref: {"value": page_value}}]}
    patch = OUT / "crop-update.json"
    patch.write_text(json.dumps(update))
    run(optimized, cropped, "--update-from-json=" + str(patch))
    run("--check", cropped)
    cropped_json = inspect(cropped)
    assert dictionary(cropped_json, cropped_json["pages"][1]["object"])["/CropBox"] == [18, 24, 594, 768]
    assert streams(cropped, cropped_json) == streams(optimized, optimized_json)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_sha
    report = {"schemaVersion": 1, "status": "passed", "elapsedSeconds": round(time.perf_counter()-start, 3),
              "checks": ["hand-built valid input", "spaced input/output paths", "reorder/extract/duplicate", "page metadata rotation", "URI link preservation", "decoded content streams unchanged", "lossless structural optimization", "CropBox JSON update", "qpdf syntax checks on each output", "original SHA256 unchanged"],
              "originalBytes": source.stat().st_size, "transformedBytes": transformed.stat().st_size,
              "optimizedBytes": optimized.stat().st_size, "croppedBytes": cropped.stat().st_size,
              "optimizationDeltaBytes": optimized.stat().st_size-transformed.stat().st_size,
              "limitation": "Native-engine integration only; not a complete PDF fidelity or independent rendering test."}
    (APP / "docs/native-engine-smoke-results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
