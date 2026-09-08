#!/usr/bin/env python3
"""Deterministic, original compression teaching examples; no external documents."""
from pathlib import Path
from io import BytesIO
import math
import random
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, BooleanObject, ArrayObject, NumberObject

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-data'
OUT.mkdir(exist_ok=True)
rng = random.Random(315)
image = Image.new('RGB', (1200, 720))
pixels = []
for y in range(image.height):
    for x in range(image.width):
        noise = rng.randrange(-15, 16)
        ridge = 320 + 90 * math.sin(x / 205) + 35 * math.sin(x / 67)
        if y < ridge:
            c = (174 + y / 14, 205 + y / 22, 220 + y / 40)
        else:
            c = (45 + y / 9, 100 + y / 14, 88 + y / 18)
        pixels.append(tuple(max(0, min(255, int(v + noise))) for v in c))
image.putdata(pixels)
jpeg = BytesIO(); image.save(jpeg, 'JPEG', quality=98, subsampling=0)
raw = OUT / 'optimization-lab-raw.pdf'
c = canvas.Canvas(str(raw), pagesize=(595.28, 841.89), pageCompression=0, invariant=1)
c.setTitle('Compression lab | An original educational example')
c.setAuthor('PDF Workbench')
for page in range(2):
    c.setFillColor(HexColor('#f5f3ec')); c.rect(0, 0, 596, 842, fill=1, stroke=0)
    c.setFillColor(HexColor('#176b5b')); c.rect(0, 826, 596, 16, fill=1, stroke=0)
    c.setFont('Helvetica', 10); c.drawString(42, 787, 'LEARN BY DOING     /     PDF WORKBENCH')
    c.setFillColor(HexColor('#20332d')); c.setFont('Helvetica-Bold', 34)
    c.drawString(42, 732, 'Less space.'); c.drawString(42, 691, 'Your choice of detail.')
    c.setFont('Helvetica', 12); c.drawString(43, 659, 'A generated landscape, selectable text, and vector shapes.')
    c.drawImage(ImageReader(image), 42, 302, width=511, height=306.6)
    c.setFont('Helvetica-Bold', 14); c.drawString(42, 270, 'Look closely at the texture.')
    c.setFont('Helvetica', 11)
    c.drawString(42, 248, 'Lossless preserves pixels. Image presets trade fine detail for size.')
    c.drawString(42, 230, 'JPEG quality is an encoder setting, not a percentage of fidelity.')
    c.drawImage(ImageReader(BytesIO(jpeg.getvalue())), 42, 92, width=165, height=99)
    c.setFillColor(HexColor('#176b5b'))
    for n in range(5): c.rect(243+n*52, 92, 30, 35+n*16, fill=1, stroke=0)
    c.setFont('Helvetica', 10); c.drawString(243, 205, 'These shapes stay as vectors.')
    c.setFont('Helvetica', 9); c.drawString(42, 48, f'Original generated content | Teaching example | Page {page+1} of 2')
    c.showPage()
c.save()
w = PdfWriter(clone_from=raw)
w.add_outline_item('Compression lesson', 0)
w.add_outline_item('Compare the second page', 1)
w.pages[0][NameObject('/Annots')] = ArrayObject([w._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Annot'), NameObject('/Subtype'):NameObject('/Link'), NameObject('/Rect'):ArrayObject([NumberObject(n) for n in (42, 225, 550, 245)]), NameObject('/Border'):ArrayObject([NumberObject(0)]*3), NameObject('/Dest'):ArrayObject([w.pages[1].indirect_reference, NameObject('/Fit')])}))])
w._root_object[NameObject('/MarkInfo')] = DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
w._root_object[NameObject('/StructTreeRoot')] = w._add_object(DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot'), NameObject('/K'):ArrayObject()}))
w.write(OUT / 'optimization-lab.pdf')
# A grayscale fixture exercises one-component JPEG encoding.
c = canvas.Canvas(str(OUT/'optimization-gray.pdf'), invariant=1)
c.drawImage(ImageReader(image.convert('L')), 40, 200, width=500, height=300)
c.drawString(40, 550, 'Selectable grayscale test'); c.showPage(); c.save()
# Transparency must either remain byte-identical or be rejected, never silently
# recompressed by the narrow image-validation exception.
rgba = image.convert('RGBA'); rgba.putalpha(160)
c = canvas.Canvas(str(OUT/'optimization-alpha.pdf'), invariant=1)
c.drawImage(ImageReader(rgba), 40, 200, width=500, height=300, mask='auto')
c.showPage(); c.save()
print('Created four generated optimization fixtures in the project test-data folder.')
