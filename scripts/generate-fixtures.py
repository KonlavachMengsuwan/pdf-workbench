"""Owned fixtures. No user document is read. Run with reportlab/pypdf/Pillow."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, ArrayObject, NameObject, NumberObject, TextStringObject, BooleanObject
from PIL import Image, ImageDraw
import hashlib,json
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-data'; OUT.mkdir(exist_ok=True)
font=Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
if font.exists():pdfmetrics.registerFont(TTFont('FixtureUnicode',str(font)))
else: font=None
im=Image.new('RGB',(640,420),'#eff4ed'); d=ImageDraw.Draw(im)
for i in range(8):d.rectangle((20+i*75,50+i*17,64+i*75,390),fill=['#176b5b','#df8654','#9fae96'][i%3])
im.save(OUT/'chart.png'); im.save(OUT/'chart.jpg',quality=94)
c=canvas.Canvas(str(OUT/'studio-sample.pdf'),pagesize=(595.28,841.89),pageCompression=0)
c.setTitle('Field notes | Workbench test collection');c.setAuthor('PDF Workbench owned fixture')
for n,(w,h) in enumerate([(595.28,841.89),(612,792),(760,520),(480,720)],1):
 c.setPageSize((w,h));c.setFillColor(HexColor('#f5f3ec'));c.rect(0,0,w,h,fill=1,stroke=0)
 c.setFillColor(HexColor('#176b5b'));c.rect(0,h-16,w,16,fill=1,stroke=0)
 c.setFont('Helvetica',10);c.drawString(44,h-58,'FIELD NOTES     /     PDF WORKBENCH')
 c.setFillColor(HexColor('#20332d'));c.setFont('Helvetica-Bold',32);c.drawString(44,h-114,['A quieter way','Make room for','Small details,','Built to keep'][n-1]);c.drawString(44,h-152,['to work.','the next idea.','clear thinking.','the original.'][n-1])
 c.setFont('Helvetica',12);c.drawString(46,h-187,f'PAGE {n}   /   Asymmetric layout and vector type')
 c.drawImage(str(OUT/'chart.png'),44,110,width=w-88,height=min(270,h-320),preserveAspectRatio=False)
 c.setFillColor(HexColor('#bd633e'));c.circle(w-46,48,10,fill=1,stroke=0)
 c.setFillColor(HexColor('#20332d'));c.setFont('FixtureUnicode' if font else 'Helvetica',11);c.drawString(44,65,'English · Größe und Maß · ภาษาไทย' if font else 'English - German: Grosse und Mass')
 c.setFont('Helvetica',8);c.drawString(44,42,f'Origin marker BOTTOM LEFT | page {n} | x=44 y=42')
 c.setStrokeColor(HexColor('#176b5b'));c.line(20,20,120,20);c.line(20,20,20,100)
 c.showPage()
c.save()
r=PdfReader(OUT/'studio-sample.pdf')
def base(name):
 w=PdfWriter();w.clone_document_from_reader(r);return w
w=base('rotated');w.pages[1].rotate(90);w.pages[2].cropbox.lower_left=(25,30);w.write(OUT/'mixed-rotation-crop.pdf')
w=base('bookmark');w.add_outline_item('Start',0);w.add_outline_item('Details',2);w.write(OUT/'bookmarks.pdf')
w=base('link');w.add_annotation(0,DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(x) for x in [44,20,200,45]]),NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject('/URI'),NameObject('/URI'):TextStringObject('https://example.com')})}));w.write(OUT/'links.pdf')
c=canvas.Canvas(str(OUT/'forms.pdf'));c.drawString(44,760,'Interactive form: must open read-only');c.acroForm.textfield(name='reviewer',x=44,y=680,width=220,height=25,value='Original');c.showPage();c.save()
# A fresh writer avoids inheriting a ReportLab trailer ID decoded as text by
# pypdf, which can fail while deriving the encryption key. Only fixture pages
# are needed here; the app must reject this password-protected test input.
w=PdfWriter()
for page in r.pages:w.add_page(page)
w.encrypt('test-password');w.write(OUT/'encrypted.pdf')
w=base('tagged');w._root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)});w._root_object[NameObject('/StructTreeRoot')]=w._add_object(DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot'),NameObject('/K'):ArrayObject()}));w.write(OUT/'tags.pdf')
w=base('attachments');w.add_attachment('owned-test.txt',b'Attachment must never disappear silently');w.write(OUT/'attachments.pdf')
w=base('signed-field');sig=w._add_object(DictionaryObject({NameObject('/FT'):NameObject('/Sig'),NameObject('/T'):TextStringObject('Unverified signature test field')}));w._root_object[NameObject('/AcroForm')]=w._add_object(DictionaryObject({NameObject('/Fields'):ArrayObject([sig])}));w.write(OUT/'signature-field.pdf')
w=base('nonzero');w.pages[0].mediabox.lower_left=(10,20);w.write(OUT/'nonzero-origin.pdf')
w=PdfWriter()
for i in range(50):w.add_page(r.pages[i%4])
w.write(OUT/'large-50-pages.pdf')
w=PdfWriter();w.add_blank_page(width=595,height=842);w.write(OUT/'blank.pdf')
(OUT/'malformed.pdf').write_bytes(b'%PDF-1.7\nnot a PDF\n')
import runpy
runpy.run_path(str(Path(__file__).with_name('generate-optimization-fixtures.py')))
manifest={p.name:{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in OUT.iterdir() if p.suffix in ['.pdf','.png','.jpg'] and not p.name.startswith('._')}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'fixtures':len(manifest),'output':str(OUT),'unicodeFont':bool(font)}))
