#!/usr/bin/env python3
"""Generate additional owned fixtures in test-data/extra; never touch base data."""
from pathlib import Path
import hashlib
import json
import random
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test-data/extra"
OUT.mkdir(parents=True, exist_ok=True)
UNICODE = Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf")
if UNICODE.exists():
    pdfmetrics.registerFont(TTFont("ExtraUnicode", str(UNICODE)))
FONT = "ExtraUnicode" if UNICODE.exists() else "Helvetica"


def document(name, title, label):
    c = canvas.Canvas(str(OUT / name), pagesize=(612, 792), pageCompression=0, invariant=1, pdfVersion=(1, 4))
    c.setTitle(title)
    c.setAuthor("PDF Workbench owned test fixture")
    c.setFillColor(HexColor("#f8f6ef")); c.rect(0, 0, 612, 792, stroke=0, fill=1)
    c.setFillColor(HexColor("#146759")); c.rect(0, 772, 612, 20, stroke=0, fill=1)
    c.setFont("Helvetica", 10); c.drawString(44, 740, "PDF WORKBENCH  /  ADDITIONAL ENGINE FIXTURES")
    c.setFillColor(HexColor("#20352f")); c.setFont("Helvetica-Bold", 26); c.drawString(44, 694, title)
    c.setFont("Helvetica", 10); c.drawString(44, 668, label)
    return c


def lines(c, text, x, y, width=40):
    import textwrap
    c.setFont(FONT, 10)
    for line in textwrap.wrap(text, width):
        c.drawString(x, y, line); y -= 17
    return y


c = document("multicolumn.pdf", "Two columns, one page", "Selectable text in separate columns with footnotes and a vector chart.")
for x, heading, body in [
    (44, "LEFT COLUMN / observations", "Left column content A. An exported document must keep text selectable and preserve font resources. This paragraph occupies a narrow column. Page organization must never replace these characters with a screenshot."),
    (322, "RIGHT COLUMN / interpretation", "Right column content B. Reading order can differ from visual order in complex PDFs. TXT extraction must report that limitation clearly. Rotation and structural optimization must preserve all original character data."),
]:
    c.setFont("Helvetica-Bold", 11); c.drawString(x, 620, heading)
    y = lines(c, body, x, 590)
    lines(c, body, x, y-25)
c.setStrokeColor(HexColor("#c4d2c9")); c.line(302, 205, 302, 635)
c.setFillColor(HexColor("#267965"))
for i, height in enumerate((40, 80, 58, 105, 70)):
    c.rect(48+i*95, 108, 62, height, stroke=0, fill=1)
c.setFont(FONT, 9); c.setFillColor(HexColor("#20352f")); c.drawString(44, 60, "Footnote 1: two columns are visual layout, not a guarantee of semantic reading order.")
c.showPage(); c.save()

c = document("equations.pdf", "Equations stay selectable", "Embedded Unicode glyphs, superscripts, fraction rules, and vector geometry.")
c.setFont(FONT, 25); c.drawString(50, 598, "E = mc")
c.setFont(FONT, 15); c.drawString(134, 611, "2")
c.setFont(FONT, 20); c.drawString(50, 528, "f(x) = ax² + bx + c" if UNICODE.exists() else "f(x) = ax^2 + bx + c")
c.setFont(FONT, 20); c.drawString(50, 455, "x =")
c.setFont(FONT, 18); c.drawString(108, 474, "−b ± √(b² − 4ac)" if UNICODE.exists() else "-b +/- sqrt(b^2 - 4ac)")
c.setStrokeColor(HexColor("#20352f")); c.setLineWidth(1.1); c.line(100, 462, 282, 462)
c.drawCentredString(191, 435, "2a")
c.setFont(FONT, 20); c.drawString(50, 350, "∫₀¹ x² dx = 1/3" if UNICODE.exists() else "Integral 0..1 x^2 dx = 1/3")
c.setFont(FONT, 12); c.drawString(50, 290, "Equation marker ALPHA: x, y, 0, 1, 2, 3 and baseline punctuation.")
c.setLineWidth(1); c.line(60, 90, 60, 240); c.line(60, 90, 480, 90)
path=c.beginPath(); path.moveTo(60, 90); path.curveTo(200, 90, 340, 130, 470, 232)
c.setStrokeColor(HexColor("#c27542")); c.setLineWidth(3); c.drawPath(path)
c.showPage(); c.save()

c = document("transparency.pdf", "Layers without flattening", "Overlapping translucent vectors, a vector form, clipping, and fine strokes.")
c.saveState()
c.setFillColor(HexColor("#0d7661")); c.setFillAlpha(0.45); c.circle(222, 450, 112, fill=1, stroke=0)
c.setFillColor(HexColor("#ed8a43")); c.setFillAlpha(0.45); c.circle(342, 450, 112, fill=1, stroke=0)
c.setFillColor(HexColor("#375bad")); c.setFillAlpha(0.45); c.circle(282, 350, 112, fill=1, stroke=0)
c.restoreState()
c.beginForm("vector-form", 0, 0, 210, 74)
c.setFillColor(HexColor("#146759")); c.roundRect(0, 0, 210, 74, 9, fill=1, stroke=0)
c.setFillColor(HexColor("#ffffff")); c.setFont("Helvetica-Bold", 13); c.drawString(18, 32, "TEXT INSIDE A FORM")
c.endForm()
c.saveState(); c.translate(52, 152); c.doForm("vector-form"); c.restoreState()
c.saveState(); clip=c.beginPath(); clip.rect(328, 153, 185, 72); c.clipPath(clip, stroke=0, fill=0)
c.setFillColor(HexColor("#c27542")); c.setFillAlpha(0.5); c.circle(390, 210, 88, fill=1, stroke=0); c.restoreState()
c.setFont(FONT, 10); c.setFillColor(HexColor("#20352f")); c.drawString(52, 100, "TRANSPARENCY marker: alpha graphics must remain vector operations.")
c.setDash(3, 3); c.setStrokeColor(HexColor("#146759")); c.line(52, 80, 520, 80)
c.showPage(); c.save()

# Simulated scan: the source pixels include the text. The PDF itself contains
# no text objects and deliberately cannot yield selectable TXT without OCR.
scan = Image.new("RGB", (1224, 1584), "#f4f2e9")
draw = ImageDraw.Draw(scan)
try:
    scan_font = ImageFont.truetype(str(UNICODE), 32)
    scan_title = ImageFont.truetype(str(UNICODE), 56)
except OSError:
    scan_font = ImageFont.load_default(size=32); scan_title = ImageFont.load_default(size=56)
draw.text((88, 120), "SIMULATED SCAN", font=scan_title, fill="#283832")
paragraphs = ["This page contains only image pixels.", "No selectable PDF text is present.", "OCR is intentionally outside Stage 0.1.", "Native operations must preserve these samples."]
for i, text in enumerate(paragraphs):
    draw.text((88, 280+i*80), text, font=scan_font, fill="#3b443f")
draw.rectangle((100, 760, 1080, 790), fill="#176b5b")
for i in range(5):
    draw.rectangle((100+i*196, 880+i*40, 210+i*196, 1240), fill=(90+i*18, 100+i*16, 85+i*18))
rng = random.Random(49152)
for _ in range(1000):
    x,y=rng.randrange(scan.width),rng.randrange(scan.height)
    shade=rng.randrange(200,231); draw.point((x,y), fill=(shade,shade,shade))
scan.save(OUT/"scan-source.png")
c = canvas.Canvas(str(OUT/"scan.pdf"), pagesize=(612,792), pageCompression=0, invariant=1)
c.setTitle("Owned simulated scan - no selectable text")
c.drawImage(str(OUT/"scan-source.png"),0,0,width=612,height=792)
c.showPage(); c.save()

names = ["multicolumn.pdf", "equations.pdf", "transparency.pdf", "scan.pdf", "scan-source.png"]
manifest = {name: {"bytes": (OUT/name).stat().st_size, "sha256": hashlib.sha256((OUT/name).read_bytes()).hexdigest()} for name in names}
(OUT/"manifest.json").write_text(json.dumps({"schemaVersion":1,"unicodeFontEmbedded":UNICODE.exists(),"files":manifest},indent=2)+"\n")
print(json.dumps({"output":str(OUT),"files":len(manifest),"unicodeFontEmbedded":UNICODE.exists()},indent=2))
