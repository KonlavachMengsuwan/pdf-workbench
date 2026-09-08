#!/usr/bin/env python3
"""Verify an app-exported editing copy against explicit original page numbers.

This reads PDFs only. Reports and independent Poppler renders stay under tmp/.
For unmodified geometry it requires exact rendered pixels, not just page counts.
"""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageChops
from pypdf import PdfReader
from validate_exports import fonts, images
from validate_preserved_pdf import ROOT, graph, feature_keys, run


def validate(args, report, check):
    original = args.source.resolve(strict=True)
    output = args.output.resolve(strict=True)
    if os.path.samefile(original, output):
        raise ValueError('The export must be a separate file.')
    source_hash = hashlib.sha256(original.read_bytes()).hexdigest()
    result_hash = hashlib.sha256(output.read_bytes()).hexdigest()
    before, after = PdfReader(original), PdfReader(output)
    mapping = [int(value) for value in args.page_map.split(',')]
    if not mapping or len(mapping) > 100 or any(n < 1 or n > len(before.pages) for n in mapping):
        raise ValueError('Provide 1–100 valid source page numbers.')
    check(len(after.pages) == len(mapping), 'expected output page count')
    check(not feature_keys(graph(output)['qpdf'][1]), 'disclosed structures removed in editing copy')
    graph(original)  # Independent qpdf syntax check, without changing input.
    for index, source_number in enumerate(mapping):
        old, new = before.pages[source_number - 1], after.pages[index]
        prefix = f'output {index+1} = original {source_number}: '
        check(old.extract_text() == new.extract_text(), prefix + 'selectable text')
        check(fonts(old) == fonts(new), prefix + 'embedded fonts and Unicode maps')
        check(images(old) == images(new), prefix + 'decoded image samples')
        check(list(old.mediabox) == list(new.mediabox), prefix + 'paper bounds')
        check(list(old.cropbox) == list(new.cropbox), prefix + 'crop bounds')
        check(old.rotation == new.rotation, prefix + 'rotation')
    directory = args.report.parent / (args.report.stem + '-renders')
    directory.mkdir(parents=True, exist_ok=True)
    cache = ROOT / 'caches/page-map-validation'
    cache.mkdir(parents=True, exist_ok=True)
    config = directory / 'fonts.conf'
    config.write_text('<fontconfig><dir>/System/Library/Fonts</dir><cachedir>' + escape(str(cache)) + '</cachedir></fontconfig>')
    env = dict(os.environ, TMPDIR=str(directory), FONTCONFIG_FILE=str(config), FONTCONFIG_PATH=str(directory), XDG_CACHE_HOME=str(cache))
    rendered = {}
    for label, pdf in [('source', original), ('output', output)]:
        folder = directory / label
        folder.mkdir(exist_ok=True)
        for old in folder.glob('page-*.png'):
            old.unlink()
        run(args.pdftoppm, '-r', '96', '-cropbox', '-png', pdf, folder / 'page', env=env)
        rendered[label] = sorted(p for p in folder.glob('page-*.png') if not p.name.startswith('._'))
        check(len(rendered[label]) == len(PdfReader(pdf).pages), label + ': all pages independently rendered')
    for index, source_number in enumerate(mapping):
        with Image.open(rendered['source'][source_number - 1]) as old, Image.open(rendered['output'][index]) as new:
            check(old.size == new.size, f'output {index+1}: rendered dimensions')
            difference = ImageChops.difference(old.convert('RGB'), new.convert('RGB'))
            check(all(high == 0 for low, high in difference.getextrema()), f'output {index+1}: exact mapped pixel equality')
    check(hashlib.sha256(original.read_bytes()).hexdigest() == source_hash, 'original SHA256 unchanged')
    check(hashlib.sha256(output.read_bytes()).hexdigest() == result_hash, 'export SHA256 unchanged during validation')
    report.update(sourceSha256=source_hash, outputSha256=result_hash, sourceBytes=original.stat().st_size,
                  outputBytes=output.stat().st_size, pageMap=mapping,
                  renderedPages=len(before.pages) + len(after.pages),
                  limitations=['Editing-copy validation: navigation, tags and metadata are explicitly removed.',
                               'No universal PDF conformance or accessibility claim.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--page-map', required=True)
    parser.add_argument('--pdftoppm', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    args.report = args.report.resolve()
    if not args.report.is_relative_to(ROOT / 'tmp'):
        parser.error('Reports and renders must stay under the project tmp directory.')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {'schemaVersion': 1, 'status': 'running', 'checks': []}
    def check(condition, name):
        report['checks'].append({'name': name, 'passed': bool(condition)})
        if not condition:
            raise AssertionError(name)
    started = time.perf_counter()
    try:
        validate(args, report, check)
        report['status'] = 'passed'
    except Exception as error:
        report.update(status='failed', error=str(error))
        raise
    finally:
        report.update(elapsedSeconds=round(time.perf_counter()-started, 3),
                      passedChecks=sum(item['passed'] for item in report['checks']))
        args.report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ('status', 'passedChecks', 'elapsedSeconds')}))


if __name__ == '__main__':
    main()
