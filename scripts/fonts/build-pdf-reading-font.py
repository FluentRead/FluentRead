"""Create the checked-in static PDF font from the existing OFL interface font.

Offline maintenance operation, not part of a build or browser runtime.
Validated with Python 3.9 / fontTools 4.38.0. WOFF2 input requires Brotli.
An optional original TTF path avoids needing a WOFF2 decoder.
WOFF2 compression uses Node's built-in Brotli, without installing a Python codec.
"""
from hashlib import sha256
from copy import deepcopy
from pathlib import Path
import subprocess
from types import SimpleNamespace
import sys
from fontTools.ttLib import TTFont, woff2
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'assets/interface-fonts/NotoSansSC.woff2'
target = root / 'public/pdf-fonts/FluentReadNotoSansSC-Regular.woff2'
expected = ('a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
            if source.suffix == '.ttf' else 'aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a')
assert sha256(source.read_bytes()).hexdigest() == expected, 'Font source changed; review its provenance before regenerating'
font = TTFont(source, recalcTimestamp=False)
font = instantiateVariableFont(font, {'wght': 400}, inplace=True, updateFontNames=True)
font.flavor = None
# fontkit 1.1.1 emits short loca offsets in small subsets without adding padding.
# Align every source glyph so subsetting cannot truncate an odd byte offset.
font['glyf'].padding = 4
# One CID must represent one Unicode character. A source font may share a
# glyph (e.g. U+00B7/U+2022); pdf-lib otherwise collapses its ToUnicode mapping.
seen = set()
order = list(font.getGlyphOrder())
aliases = 0
for codepoint, glyph_name in sorted(font.getBestCmap().items()):
    if glyph_name not in seen:
        seen.add(glyph_name)
        continue
    name = f'{glyph_name}.frU{codepoint:06X}'
    font['glyf'][name] = deepcopy(font['glyf'][glyph_name])
    font['hmtx'][name] = font['hmtx'][glyph_name]
    if 'vmtx' in font:
        font['vmtx'][name] = font['vmtx'][glyph_name]
    order.append(name)
    for table in font['cmap'].tables:
        if table.isUnicode() and table.cmap.get(codepoint) == glyph_name:
            table.cmap[codepoint] = name
    aliases += 1
font.setGlyphOrder(order)
names = {1: 'FluentRead Noto Sans SC', 2: 'Regular', 3: 'FluentReadNotoSansSC-Regular',
         4: 'FluentRead Noto Sans SC Regular', 6: 'FluentReadNotoSansSC-Regular',
         16: 'FluentRead Noto Sans SC', 17: 'Regular'}
for record in font['name'].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
target.parent.mkdir(parents=True, exist_ok=True)

def brotli_compress(data, mode=2):
    encoder = ('const z=require("node:zlib"),f=require("node:fs");'
               'process.stdout.write(z.brotliCompressSync(f.readFileSync(0),{params:{'
               '[z.constants.BROTLI_PARAM_MODE]:2,[z.constants.BROTLI_PARAM_QUALITY]:11}}));')
    return subprocess.run(['node', '-e', encoder], input=data,
                          stdout=subprocess.PIPE, check=True).stdout

# Only the standard Brotli compressor is replaced. Keep glyf/loca raw:
# fontkit 1.1.1 can read transformed WOFF2 glyphs but its PDF subset encoder
# cannot serialize those transformed tables as TrueType glyph records.
woff2.brotli = SimpleNamespace(compress=brotli_compress, MODE_FONT=2)
woff2.haveBrotli = True
font.flavor = 'woff2'
font.flavorData = woff2.WOFF2FlavorData(transformedTables=set())
font.save(target)
data = target.read_bytes()
print(f'{target.name}: {len(data)} bytes, SHA256 {sha256(data).hexdigest()}, {aliases} Unicode alias glyphs separated')
