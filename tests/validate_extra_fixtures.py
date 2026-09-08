#!/usr/bin/env python3
"""Native merge/reorder/rotate/optimize verification for extra content types."""
from pathlib import Path
import argparse
import json
import os
import shutil
import time
from xml.sax.saxutils import escape
from PIL import Image
from pypdf import PdfReader
import validate_exports as validation

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "test-data/extra"
OUT = ROOT / "tmp/test-results/extra"
NAMES = ["multicolumn", "equations", "transparency", "scan"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdftoppm", default=os.environ.get("PDFWORKBENCH_PDFTOPPM") or shutil.which("pdftoppm"))
    args = parser.parse_args()
    if not args.pdftoppm: raise SystemExit("Pass --pdftoppm with a Poppler renderer path.")
    OUT.mkdir(parents=True, exist_ok=True)
    validation.OUT = OUT
    validation.RENDERS = OUT / "renders"
    validation.RENDERS.mkdir(exist_ok=True)
    validation.REPORT = {"schemaVersion":1,"status":"running","checks":[],"renderComparisons":[],"files":{}}
    report=validation.REPORT; check=validation.check; command=validation.command
    cache=ROOT/"cache/validation/fontconfig";cache.mkdir(parents=True,exist_ok=True)
    (OUT/"fonts.conf").write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>/System/Library/Fonts</dir><cachedir>'+escape(str(cache))+'</cachedir></fontconfig>')
    original_manifest=(ROOT/"test-data/manifest.json").read_bytes()
    original_files=json.loads(original_manifest)
    extra_files=json.loads((DATA/"manifest.json").read_text())["files"]
    start=time.perf_counter()
    try:
        readers={name:PdfReader(DATA/(name+".pdf")) for name in NAMES}
        text=readers["multicolumn"].pages[0].extract_text()
        check("LEFT COLUMN" in text and "RIGHT COLUMN" in text and "Footnote 1" in text,"multi-column fixture has selectable columns and footnote")
        text=readers["equations"].pages[0].extract_text()
        check("E = mc" in text and "Equation marker ALPHA" in text and "∫" in text,"equation fixture has selectable equation glyphs")
        transparent=readers["transparency"].pages[0]
        states=transparent["/Resources"]["/ExtGState"].get_object()
        check(any(float(value.get_object().get("/ca",1))<1 for value in states.values()),"transparency fixture has actual alpha graphics states")
        check(any(value.get_object().get("/Subtype")=="/Form" for value in transparent["/Resources"]["/XObject"].get_object().values()),"transparency fixture has a vector Form XObject")
        check("TEXT INSIDE A FORM" in transparent.extract_text(),"text inside Form XObject is independently extractable")
        scan=readers["scan"].pages[0]
        check(not scan.extract_text().strip(),"scan fixture contains no selectable text (OCR remains required)")
        with Image.open(DATA/"scan-source.png") as original:
            check(validation.images(scan)==[validation.image_signature(original)],"scan source pixels are faithfully embedded")
        merge_args=[validation.QPDF,"--empty","--pages"]
        for name in NAMES:merge_args.extend([DATA/(name+".pdf"),"1"])
        command(*merge_args,"--",OUT/"merged.pdf")
        merged=PdfReader(OUT/"merged.pdf")
        check(len(merged.pages)==4,"native merge includes all four distinct content types")
        for index,name in enumerate(NAMES):
            page=merged.pages[index];original=readers[name].pages[0]
            check(page.extract_text()==original.extract_text(),name+": merge preserves selectable text")
            check(validation.fonts(page)==validation.fonts(original),name+": merge preserves font programs")
            check(validation.images(page)==validation.images(original),name+": merge preserves decoded image samples")
            check(page.get_contents().get_data()==original.get_contents().get_data(),name+": original vector/content operators preserved")
        command(validation.QPDF,OUT/"merged.pdf","--pages",".","3,1,2,4,3","--",OUT/"reordered.pdf")
        validation.same_resources(OUT/"reordered.pdf",[2,0,1,3,2],merged)
        command(validation.QPDF,OUT/"merged.pdf",OUT/"rotated.pdf","--rotate=+90:1")
        rotated=validation.same_resources(OUT/"rotated.pdf",range(4),merged)
        check(rotated.pages[0].rotation==90,"native rotation updates metadata without rasterizing columns")
        command(validation.QPDF,OUT/"merged.pdf",OUT/"optimized.pdf","--object-streams=generate","--recompress-flate","--compression-level=9")
        optimized=validation.same_resources(OUT/"optimized.pdf",range(4),merged)
        for index,name in enumerate(NAMES):
            check(optimized.pages[index].get_contents().get_data()==merged.pages[index].get_contents().get_data(),name+": optimization preserves decoded content operators")
        for path in [DATA/(name+".pdf") for name in NAMES]+[OUT/(name+".pdf") for name in ["merged","reordered","rotated","optimized"]]:
            command(validation.QPDF,"--check",path)
        rendered={name:validation.render(args.pdftoppm,DATA/(name+".pdf")) for name in NAMES}
        with Image.open(rendered["transparency"][0]) as alpha_image:
            expected=[248.,246.,239.]
            for rgb in [(13,118,97),(237,138,67),(55,91,173)]:
                expected=[background*.55+foreground*.45 for background,foreground in zip(expected,rgb)]
            actual=alpha_image.convert("RGB").getpixel((round(282*96/72),round((792-450)*96/72)))
            check(all(abs(a-e)<4 for a,e in zip(actual,expected)),"independent renderer confirms visible 45-percent alpha compositing",pixel=list(actual),expected=expected)
        for name in ["merged","reordered","rotated","optimized"]:
            rendered[name]=validation.render(args.pdftoppm,OUT/(name+".pdf"))
        for index,name in enumerate(NAMES):
            validation.compare_pixels(rendered[name][0],rendered["merged"][index],name+": merged visual fidelity")
            validation.compare_pixels(rendered["merged"][index],rendered["optimized"][index],name+": lossless optimization visual fidelity")
        for index,original_index in enumerate([2,0,1,3,2]):
            validation.compare_pixels(rendered["merged"][original_index],rendered["reordered"][index],"reorder/duplicate output page "+str(index+1))
        with Image.open(rendered["merged"][0]) as original,Image.open(rendered["rotated"][0]) as changed:
            check(changed.size==original.size[::-1],"independent renderer confirms rotated column-page dimensions")
        for name,expected in extra_files.items():
            check(validation.digest((DATA/name).read_bytes())==expected["sha256"],"extra fixture input hash unchanged: "+name)
        check((ROOT/"test-data/manifest.json").read_bytes()==original_manifest,"base fixture manifest unchanged")
        for name,expected in original_files.items():
            check(validation.digest((ROOT/"test-data"/name).read_bytes())==expected["sha256"],"base fixture input hash unchanged: "+name)
        report["optimization"]={"beforeBytes":(OUT/"merged.pdf").stat().st_size,"afterBytes":(OUT/"optimized.pdf").stat().st_size,"changeBytes":(OUT/"optimized.pdf").stat().st_size-(OUT/"merged.pdf").stat().st_size}
        report["renderedPageCount"]=sum(map(len,rendered.values()))
        report["limitations"]=["Controlled fixtures, not an arbitrary-document fidelity guarantee.","The simulated scan is intentionally image-only; no OCR is performed.","Windows has not been run."]
        report["status"]="passed"
    except Exception as error:
        report["status"]="failed";report["error"]=str(error)
        raise
    finally:
        report["elapsedSeconds"]=round(time.perf_counter()-start,3)
        report["passedChecks"]=sum(item["passed"] for item in report["checks"])
        (ROOT/"tmp/test-results/extra-validation.json").write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps({key:report[key] for key in ["status","passedChecks","elapsedSeconds"]},indent=2))


if __name__=="__main__":main()
