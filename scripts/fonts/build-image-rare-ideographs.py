"""Subset the pinned Hanazono TrueType font and its glyph variants.

Offline maintenance command. Use Python 3.9, fontTools 4.38, and Node 24.
The original font and accompanying license are documented in PROVENANCE.json.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

from fontTools import subset
from fontTools.ttLib import TTFont, woff2


SOURCE_DIGEST = '7ca87559414474848fc513a8d8eb42d5b0f8194c30c2abdfbfedff5398ec88d7'
FONT_FAMILY = 'FluentRead Rare Ideographs'
FONT_NAME = 'FluentReadRareIdeographs-Regular'
DESTINATION = Path(__file__).resolve().parents[2] / 'public' / 'fluent-read-image-fonts'


def jis_supplementary_ideographs():
    """Use the EUC-JIS-2004 mapping for planes 1 and 2 of JIS X 0213."""
    codepoints = set()
    for prefix in (b'', b'\x8f'):
        for lead in range(0xa1, 0xff):
            for trail in range(0xa1, 0xff):
                try:
                    characters = (prefix + bytes([lead, trail])).decode('euc_jis_2004')
                except UnicodeDecodeError:
                    continue
                codepoints.update(ord(char) for char in characters if 0x20000 <= ord(char) <= 0x2ebef)
    return codepoints


def brotli_compressor(node):
    encoder = (
        'const z = require("node:zlib"), fs = require("node:fs");'
        'process.stdout.write(z.brotliCompressSync(fs.readFileSync(0), {params: {'
        '[z.constants.BROTLI_PARAM_MODE]: 2, [z.constants.BROTLI_PARAM_QUALITY]: 11}}));'
    )

    def compress(data, mode=2):
        return subprocess.run([node, '-e', encoder], input=data, stdout=subprocess.PIPE, check=True).stdout

    return compress


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != SOURCE_DIGEST:
        parser.error('The original font does not match the recorded source hash.')

    jis = jis_supplementary_ideographs()
    codepoints = jis | {0x20000, 0x20bb7}
    font = TTFont(args.source, recalcTimestamp=False)
    subsetter = subset.Subsetter()
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    if not len(jis) == 303 or set(font.getBestCmap()) != codepoints:
        raise ValueError('Font subsetting changed the expected repertoire.')
    variation_map = next(table.uvsDict for table in font['cmap'].tables if table.format == 14)
    variations = [(base, glyph) for pairs in variation_map.values() for base, glyph in pairs]
    if len(variations) != 485 or any(base not in codepoints or glyph is None for base, glyph in variations):
        raise ValueError('Font subsetting changed the expected variation sequences.')

    license_text = (DESTINATION / 'OFL.txt').read_text().strip()
    names = {
        1: FONT_FAMILY, 2: 'Regular', 3: FONT_NAME, 4: f'{FONT_FAMILY} Regular',
        6: FONT_NAME, 13: license_text, 14: 'https://openfontlicense.org/',
        16: FONT_FAMILY, 17: 'Regular',
    }
    for name_id, name in names.items():
        font['name'].removeNames(nameID=name_id)
        font['name'].setName(name, name_id, 3, 1, 0x409)

    woff2.brotli = SimpleNamespace(compress=brotli_compressor(args.node), MODE_FONT=2)
    woff2.haveBrotli = True
    font.flavor = 'woff2'
    asset = DESTINATION / f'{FONT_NAME}.woff2'
    font.save(asset)
    print(json.dumps({
        'size': asset.stat().st_size,
        'sha256': hashlib.sha256(asset.read_bytes()).hexdigest(),
        'codepoints': len(codepoints),
        'variationSequences': len(variations),
    }))


if __name__ == '__main__':
    main()
