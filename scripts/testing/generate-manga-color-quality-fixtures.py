#!/usr/bin/env python3
"""@file scripts/testing/generate-manga-color-quality-fixtures.py
文件职责：以首次 OCR 前冻结的原创设计和同 SHA 字体重建八类彩色漫画输入。
主要内容：保留原图形、字形和 source-over 像素算法；先验证全部生成内容，再独占写入新目录。
模块边界：只生成测试资源，不加载模型、不访问浏览器、不下载字体；不改原冻结 manifest 字段。
"""
from pathlib import Path
import argparse,gzip,hashlib,io,json,math,struct
import PIL
from PIL import Image,ImageDraw,ImageFont
HERE=Path(__file__).resolve().parent
FIXTURES=HERE.parent.parent/'tests'/'fixtures'/'manga-color-quality'
MANIFEST_SHA='3ceb90f8fc34d3b261898ae5045d4002873ca471dd7ff8e57e72dee6274b444f'
ORIGINAL_GENERATOR_SHA='1ee1ff0a9644eee547c863559296b58580f45053880ec6f01be2e6bdb21a9dc7'
DESIGN_SHA='b24b2d1ee63ea1ad03e1770126410cea2f82b271c35fd14d0a4f15295cc68acf'
def sha(v):return hashlib.sha256(v).hexdigest()
def png(im):
 b=io.BytesIO();im.save(b,format='PNG',optimize=False);return b.getvalue()
def box(v):return dict(zip(('x0','y0','x1','y1'),v))
def overlap(a,b):return min(a['x1'],b['x1'])>max(a['x0'],b['x0']) and min(a['y1'],b['y1'])>max(a['y0'],b['y0'])
def has_glyph(data,codepoint):
 off=struct.unpack_from('>I',data,12)[0]if data[:4]==b'ttcf'else 0
 count=struct.unpack_from('>H',data,off+4)[0]
 tables={data[off+12+i*16:off+16+i*16]:struct.unpack_from('>II',data,off+20+i*16)for i in range(count)}
 start=tables[b'cmap'][0];count=struct.unpack_from('>H',data,start+2)[0]
 for i in range(count):
  platform,encoding,pos=struct.unpack_from('>HHI',data,start+4+i*8);s=start+pos;fmt=struct.unpack_from('>H',data,s)[0]
  if platform not in (0,3):continue
  if fmt==12:
   for j in range(struct.unpack_from('>I',data,s+12)[0]):
    lo,hi,g=struct.unpack_from('>III',data,s+16+j*12)
    if lo<=codepoint<=hi and g+codepoint-lo:return True
  elif fmt==4 and codepoint<=65535:
   n=struct.unpack_from('>H',data,s+6)[0]//2;end=s+14;begin=end+n*2+2;delta=begin+n*2;ranges=delta+n*2
   for j in range(n):
    hi=struct.unpack_from('>H',data,end+j*2)[0];lo=struct.unpack_from('>H',data,begin+j*2)[0]
    if lo<=codepoint<=hi:
     d=struct.unpack_from('>h',data,delta+j*2)[0];r=struct.unpack_from('>H',data,ranges+j*2)[0]
     g=(codepoint+d)&65535 if r==0 else struct.unpack_from('>H',data,ranges+j*2+r+2*(codepoint-lo))[0]
     if r and g:g=(g+d)&65535
     if g:return True
 return False
def gradient(im,bounds,a,b,horizontal=False):
 x0,y0,x1,y1=bounds;d=ImageDraw.Draw(im);span=(x1-x0 if horizontal else y1-y0)-1
 for n in range(span+1):
  c=tuple(round(a[k]+(b[k]-a[k])*n/max(1,span))for k in range(4))
  if horizontal:d.line((x0+n,y0,x0+n,y1-1),fill=c)
  else:d.line((x0,y0+n,x1-1,y0+n),fill=c)
def art(spec):
 name=spec['name'];w,h=spec['width'],spec['height'];im=Image.new('RGBA',(w,h),(244,239,222,255));d=ImageDraw.Draw(im)
 if name=='harbor-same-red-channel-dialogue':
  gradient(im,(0,0,w,h),(247,226,191,255),(167,211,220,255));d=ImageDraw.Draw(im)
  d.polygon([(0,650),(w,550),(w,h),(0,h)],fill=(72,143,162,255))
  for i in range(6):
   x=60+i*70;d.rectangle((x,550-i%2*20,x+58,730),fill=(175+i*8,110+i*6,93,255));d.polygon([(x-5,550-i%2*20),(x+29,510-i%2*20),(x+64,550-i%2*20)],fill=(96,76,92,255))
  d.polygon([(1040,720),(1320,720),(1270,785),(1080,785)],fill=(100,66,54,255));d.line((1180,650,1180,742),fill=(57,59,66,255),width=8);d.polygon([(1184,655),(1285,710),(1184,710)],fill=(235,214,174,255))
  for y in range(760,830,17):d.line((50,y,800,y-30),fill=(143,200,208,255),width=3)
  d.rounded_rectangle((70,90,710,300),radius=42,fill=(128,218,183,255),outline=(72,102,105,255),width=4);d.polygon([(280,300),(320,345),(350,300)],fill=(128,218,183,255))
  d.rounded_rectangle((760,290,1390,510),radius=42,fill=(128,46,93,255),outline=(70,48,76,255),width=4);d.polygon([(1120,510),(1150,555),(1190,510)],fill=(128,46,93,255))
  d.rounded_rectangle((300,830,1150,925),radius=9,fill=(245,224,183,255))
 elif name=='prism-platform-gradient-signs':
  gradient(im,(0,0,w,h),(162,211,230,255),(241,209,155,255));d=ImageDraw.Draw(im)
  for x in range(100,1600,250):d.line((x,0,x-120,900),fill=(80,103,128,255),width=12)
  gradient(im,(100,80,1510,340),(141,71,187,255),(49,187,167,255),True);d=ImageDraw.Draw(im);d.rectangle((100,80,1510,340),outline=(41,47,71,255),width=7)
  d.rounded_rectangle((760,430,1520,590),radius=15,fill=(20,30,54,255),outline=(231,176,80,255),width=5)
  d.rectangle((70,455,380,565),fill=(235,179,104,255),outline=(115,78,88,255),width=4)
  d.polygon([(30,850),(110,650),(550,630),(630,850)],fill=(73,110,141,255));d.polygon([(900,850),(1010,680),(1490,680),(1570,850)],fill=(119,99,155,255))
  for x in range(140,550,95):d.rectangle((x,690,x+57,745),fill=(183,220,231,255))
  for x in range(1020,1500,90):d.rectangle((x,720,x+55,765),fill=(248,200,129,255))
 elif name=='rain-garden-vertical-ruby-sidebar':
  gradient(im,(0,0,w,h),(224,237,238,255),(188,213,212,255));d=ImageDraw.Draw(im)
  d.rectangle((35,35,w-35,h-35),outline=(54,84,92,255),width=5)
  d.rounded_rectangle((640,80,1030,860),radius=50,fill=(137,224,196,255),outline=(75,106,101,255),width=5)
  d.rounded_rectangle((65,965,1035,1175),radius=12,fill=(241,235,210,255),outline=(103,116,122,255),width=4)
  for n in range(11):
   x=100+n*38;y=300+(n%4)*42;d.line((x,y,x+40,y+260),fill=(86,125,115,255),width=7);d.ellipse((x-30,y-30,x+37,y+40),fill=(131+n*5,165,143,255))
  for n in range(25):
   x=80+(n*89)%480;y=140+(n*73)%500;d.line((x,y,x-12,y+30),fill=(160,192,206,255),width=2)
  d.polygon([(65,1360),(300,1225),(545,1350),(970,1220),(970,1450),(65,1450)],fill=(108,143,122,255));d.arc((320,1240,760,1470),180,360,fill=(79,108,112,255),width=25)
 elif name=='chess-picnic-neighbor-inverse-bubbles':
  gradient(im,(0,0,w,h),(220,225,198,255),(135,169,155,255));d=ImageDraw.Draw(im)
  d.rounded_rectangle((60,105,625,350),radius=60,fill=(255,255,255,255),outline=(24,24,24,255),width=5)
  d.rounded_rectangle((655,105,1230,350),radius=60,fill=(0,0,0,255),outline=(252,249,231,255),width=5)
  d.polygon([(340,350),(380,420),(410,350)],fill=(255,255,255,255));d.polygon([(870,350),(900,420),(940,350)],fill=(0,0,0,255))
  d.polygon([(90,550),(610,535),(655,940),(100,940)],fill=(204,90,99,255));d.rectangle((130,565,570,895),fill=(219,205,169,255))
  for row in range(6):
   for col in range(8):
    x=130+col*55;y=565+row*55;d.rectangle((x,y,x+54,y+54),fill=(48,57,63,255)if(row+col)%2 else(239,222,180,255))
  for x,y in [(810,650),(930,750),(1050,650)]:d.ellipse((x-45,y-20,x+45,y+25),fill=(240,216,165,255),outline=(120,91,87,255),width=5);d.arc((x-55,y-40,x+55,y+45),0,170,fill=(76,82,88,255),width=4)
 elif name=='lantern-market-oblique-bilingual-captions':
  gradient(im,(0,0,w,h),(66,86,121,255),(143,103,130,255));d=ImageDraw.Draw(im)
  d.polygon([(50,60),(650,135),(605,310),(20,230)],fill=(244,214,154,255),outline=(181,129,123,255));d.polygon([(745,150),(1325,85),(1360,315),(795,390)],fill=(237,209,158,255),outline=(181,129,123,255))
  for x,y in [(190,460),(340,510),(500,455),(1010,525),(1190,515)]:
   d.line((x,310,x,y-45),fill=(209,185,153,255),width=3);d.ellipse((x-47,y-62,x+47,y+62),fill=(226,116,107,255),outline=(244,188,134,255),width=5);d.line((x-30,y-2,x+30,y-2),fill=(161,66,92,255),width=3)
  d.rounded_rectangle((90,680,990,850),radius=14,fill=(242,220,180,255),outline=(126,88,105,255),width=4)
  d.polygon([(985,835),(1370,865),(1348,970),(975,940)],fill=(226,191,147,255))
  d.rectangle((930,640,1370,700),fill=(117,83,117,255))
 elif name=='watercolor-ferry-translucent-notification':
  im=Image.new('RGBA',(w,h),(206,226,237,68))
  for n in range(42):
   layer=Image.new('RGBA',(w,h));q=ImageDraw.Draw(layer);x=(n*173+20)%w;y=(n*139+40)%h;r=70+(n%6)*18;q.ellipse((x-r,y-r,x+r,y+r),fill=(130+(n%5)*13,178+(n%4)*12,202+(n%3)*10,28+(n%4)*8));im=Image.alpha_composite(im,layer)
  layer=Image.new('RGBA',(w,h));q=ImageDraw.Draw(layer);q.rounded_rectangle((125,165,1080,385),radius=28,fill=(239,237,250,155),outline=(126,114,159,210),width=3);im=Image.alpha_composite(im,layer);d=ImageDraw.Draw(im)
  d.polygon([(485,760),(775,760),(735,830),(535,830)],fill=(101,80,113,255));d.line((650,610,650,780),fill=(67,79,111,255),width=7);d.polygon([(655,625),(655,745),(745,745)],fill=(237,224,182,255))
  for n in range(10):
   x=100+n*105;d.arc((x,700+(n%3)*24,x+100,760+(n%3)*24),15,150,fill=(99,153,181,100),width=3)
 elif name=='orbital-greenhouse-cutout-dialogue':
  im=Image.new('RGBA',(w,h),(52,76,108,110));d=ImageDraw.Draw(im)
  for x in range(40,w,90):d.line((x,20,x+40,h-20),fill=(101,141,165,100),width=2)
  for y in range(30,h,110):d.line((30,y,w-30,y),fill=(131,165,176,90),width=2)
  d.rounded_rectangle((90,85,650,300),radius=38,fill=(112,216,181,150),outline=(88,174,161,210),width=4)
  d.rounded_rectangle((735,395,1360,600),radius=38,fill=(112,44,90,180),outline=(169,102,147,225),width=4)
  for x,y in [(240,570),(340,600),(440,540),(1100,810),(1160,825),(1240,780)]:
   d.line((x,y,x,y+95),fill=(100,147,125,255),width=5);d.ellipse((x-40,y-24,x+38,y+24),fill=(125,190,148,255));d.ellipse((x-12,y-45,x+35,y+5),fill=(161,207,161,255))
  d.rounded_rectangle((90,825,330,925),radius=15,fill=(228,229,202,220));d.rectangle((450,940,1000,1030),fill=(225,235,221,210))
  for x,y,r in [(700,210,34),(700,620,40)]:d.ellipse((x-r,y-r,x+r,y+r),fill=(0,0,0,0))
 elif name=='wordless-stained-glass-cutout-garden':
  im=Image.new('RGBA',(w,h),(39,57,88,150));d=ImageDraw.Draw(im)
  colors=[(158,70,145,235),(45,166,176,200),(214,151,62,255),(112,202,155,180),(180,131,210,220),(61,91,158,255)]
  for k in range(8):
   x=70+k*142;d.polygon([(600,500),(x,80),(x+170,190),(x+95,420)],fill=colors[k%6]);d.polygon([(600,500),(x,910),(x+180,850),(x+100,600)],fill=colors[(k+2)%6])
  for x in [240,960]:
   d.ellipse((x-100,350,x+100,650),fill=(74,139,137,255),outline=(223,186,111,255),width=8);d.line((x,380,x,620),fill=(205,212,177,255),width=5)
  d.ellipse((555,455,645,545),fill=(0,0,0,0));d.arc((460,360,740,640),30,325,fill=(242,214,143,230),width=10)
 else:raise ValueError(name)
 return im

def glyph(spec,fonts):
 scale=spec['supersample'];font=ImageFont.truetype(str(fonts[spec['fontKey']]),spec['fontSize']*scale);stroke=spec.get('strokeWidth',0)*scale
 def one(text):
  b=font.getbbox(text,stroke_width=stroke);size=(b[2]-b[0],b[3]-b[1])
  if size[0]*size[1]>4000000:raise ValueError('Glyph resource cap')
  fill=Image.new('L',size);ImageDraw.Draw(fill).text((-b[0],-b[1]),text,font=font,fill=255)
  if stroke:
   outline=Image.new('L',size);ImageDraw.Draw(outline).text((-b[0],-b[1]),text,font=font,fill=255,stroke_width=stroke,stroke_fill=255)
   result=Image.new('RGBA',size,tuple(spec['strokeFill']));result.putalpha(outline.point(lambda v:(v*spec['strokeFill'][3]+127)//255))
  else:result=Image.new('RGBA',size)
  ink=Image.new('RGBA',size,tuple(spec['fill']));ink.putalpha(fill.point(lambda v:(v*spec['fill'][3]+127)//255));return Image.alpha_composite(result,ink)
 if spec.get('vertical'):
  parts=[one(c)for c in spec['text']];advance=spec['fontSize']*scale;result=Image.new('RGBA',(max(x.width for x in parts),advance*(len(parts)-1)+max(x.height for x in parts)))
  for n,p in enumerate(parts):result.alpha_composite(p,((result.width-p.width)//2,n*advance))
 else:result=one(spec['text'])
 result=result.resize((math.ceil(result.width/scale),math.ceil(result.height/scale)),Image.Resampling.LANCZOS)
 if spec.get('rotation'):result=result.rotate(spec['rotation'],Image.Resampling.BICUBIC,expand=True)
 if not stroke:
  # Rasterize coverage independently. A constant-color ink must not gain RGB
  # variation from a premultiplied RGBA resize before real source-over blending.
  alpha=result.getchannel('A');solid=Image.new('RGBA',result.size,tuple(spec['fill']));solid.putalpha(alpha);result=solid
 return result

def generate(out,design_path,overrides,reference_path=None):
 if out.exists()or out.is_symlink():raise FileExistsError('Output must be a nonexistent new path')
 reference_path=FIXTURES/'manifest.json'if reference_path is None else reference_path
 reference_bytes=reference_path.read_bytes()
 if sha(reference_bytes)!=MANIFEST_SHA:raise ValueError('Complete pre-first-OCR manifest is immutable')
 reference=json.loads(reference_bytes)
 db=design_path.read_bytes()
 if sha(db)!=DESIGN_SHA:raise ValueError('Frozen design changed')
 design=json.loads(db)
 if PIL.__version__!=design['pillowVersion']:raise ValueError('Exact Pillow required')
 fonts={f['key']:Path(overrides.get(f['key'],f['path']))for f in design['fontFiles']}
 for f in design['fontFiles']:
  if not fonts[f['key']].is_file()or sha(fonts[f['key']].read_bytes())!=f['sha256']:raise ValueError('Exact font SHA required: '+f['key'])
 fontbytes={key:p.read_bytes()for key,p in fonts.items()}
 for scene in design['scenes']:
  for region in scene['regions']:
   if any(not has_glyph(fontbytes[region['fontKey']],ord(c))for c in region['text']):raise ValueError('Source font is missing a declared glyph: '+region['id'])
 files={};fixtures=[]
 for scene in design['scenes']:
  im=art(scene);w,h=im.size;before=im.copy();base=png(im);basefile='truth/'+scene['name']+'.background.png';files[basefile]=base;regions=[]
  for spec in scene['regions']:
   layer=glyph(spec,fonts);local=layer.getbbox()
   if not local:raise ValueError('Empty source glyph')
   bbox=box((spec['x']+local[0],spec['y']+local[1],spec['x']+local[2],spec['y']+local[3]))
   if not(0<=bbox['x0']<bbox['x1']<=w and 0<=bbox['y0']<bbox['y1']<=h):raise ValueError('Full glyph out of image: '+spec['id']+str(bbox))
   name='truth/'+scene['name']+'.glyph-'+spec['id']+'.png';data=png(layer);files[name]=data
   im.alpha_composite(layer,(spec['x'],spec['y']))
   regions.append({'id':spec['id'],'text':spec['text'],'anchor':spec['text'],'translation':'受控译文用于完整彩色漫画回归。','bbox':bbox,'vertical':spec.get('vertical',False),'fontSize':spec['fontSize'],'fontKey':spec['fontKey'],'paragraphId':spec['paragraphId'],'sourceStyle':{k:v for k,v in spec.items()if k not in ['id','text','paragraphId']},'glyphTruth':{'file':name,'sha256':sha(data),'rgbaSha256':sha(layer.tobytes()),'alphaSha256':sha(layer.getchannel('A').tobytes()),'width':layer.width,'height':layer.height,'placement':{'x':spec['x'],'y':spec['y']},'compositing':'Pillow Image.alpha_composite, source-over; antialias and stroke included'}})
  for n in scene['negativeRegions']:
   if any(overlap(n,r['bbox'])for r in regions):raise ValueError('Negative region overlaps source glyph bbox: '+scene['name'])
  probes=[]
  for x,y in scene['protectedPoints']:
   color=im.getpixel((x,y))
   if color[3]!=255:raise ValueError('Opaque RGB probe is not opaque '+scene['name']+str((x,y,color)))
   if any(r['bbox']['x0']<=x<r['bbox']['x1']and r['bbox']['y0']<=y<r['bbox']['y1']for r in regions):raise ValueError('Probe in glyph')
   probes.append({'x':x,'y':y,'rgb':list(color[:3])})
  rgba=[{'x':x,'y':y,'rgba':list(im.getpixel((x,y)))}for x,y in scene['protectedRgbaPoints']]
  pregions=[]
  holeboxes={'orbital-greenhouse-cutout-dialogue':[(680,190,720,230),(680,600,720,640)],'wordless-stained-glass-cutout-garden':[(580,480,620,520)]}
  for i,b in enumerate(holeboxes.get(scene['name'],[])):
   bb=box(b)
   if any(overlap(bb,r['bbox'])for r in regions):raise ValueError('Hole region touches glyph')
   crop=im.crop(b);assert crop.getchannel('A').getextrema()==(0,0)
   pregions.append({'id':'transparent-hole-'+str(i+1),'bbox':bb,'rgbaSha256':sha(crop.tobytes()),'pixels':crop.width*crop.height,'requirement':'Every source RGBA pixel remains exactly unchanged through repair/draw/composite.'})
  data=png(im);file=scene['name']+'.png';files[file]=data;raw=im.tobytes();rawfile='truth/'+scene['name']+'.source-rgba.bin.gz';files[rawfile]=gzip.compress(raw,mtime=0)
  groups={}
  for r in regions:groups.setdefault(r['paragraphId'],[]).append(r['id'])
  rec={'name':scene['name'],'file':file,'mime':'image/png','width':w,'height':h,'sourceLanguage':scene['sourceLanguage'],'scene':scene['category'],'imageMode':'RGBA','sha256':sha(data),'bytes':len(data),'regions':regions,'expectedSource':[r['text']for r in regions],'expectedAnchors':[r['text']for r in regions],'anchorOccurrences':{r['text']:1 for r in regions},'forbiddenRegions':[{'id':'wordless-art-'+str(i+1),'bbox':b}for i,b in enumerate(scene['negativeRegions'])],'protectedProbes':probes,'protectedRgbaProbes':rgba,'protectedRgbaRegions':pregions,'tileBoundaryCrossings':[],'pixelTruth':{'backgroundFile':basefile,'backgroundPngSha256':sha(base),'backgroundRgbaSha256':sha(before.tobytes()),'sourceRgbaFile':rawfile,'sourceRgbaCompressedSha256':sha(files[rawfile]),'sourceRgbaSha256':sha(raw),'sourceRgbaBytes':len(raw),'format':'Row-major RGBA uint8, no padding; gzip mtime=0. Source reconstructs from background and ordered region glyph PNG source-over placements.'},'provenance':{'designSha256':DESIGN_SHA,'originalArtworkAndText':True,'sourceDesignedBeforeAnyOcr':True,'selectionByOcrResult':False,'fontsBundled':False,'oldFixturesUnmodified':True}}
  if groups:rec['paragraphGroups']=list(groups.values())
  if scene.get('expectedNoText'):rec['expectedNoText']=True
  if scene.get('colorRelations'):rec['colorRelations']=scene['colorRelations']
  fixtures.append(rec)
 manifest={'version':1,'generator':'generate-color-scenes.py','generatorSha256':ORIGINAL_GENERATOR_SHA,'designSha256':DESIGN_SHA,'sourceFrozenAtUtc':design['frozenAtUtc'],'firstOcrStatus':'Not run; all eight retained independent of OCR success.','pillowVersion':PIL.__version__,'fonts':[{k:f[k]for k in ['key','sha256']}for f in design['fontFiles']],'scoring':design['scoring'],'notes':['Eight original geometrically distinct color/alpha source diagnostics, 34 full-source anchors, one wordless scene.','Lossless source and original glyph RGBA are retained; antialiased text is source-over, not a replacement alpha write.','Only source geometry, glyph composition and truth constraints have been checked; no real OCR/translation/inpainting/browser claim.','The existing helper enforces full anchors/occurrences, excess source inventory, negative regions and exact independent paragraph groups. Additional RGBA region/probe assertions require an explicit downstream pixel oracle.','System-font files are exact-SHA local rendering dependencies and are not redistributed. No external artwork or implementation copied.'],'fixtures':fixtures,'artifactInventory':{name:{'sha256':sha(b),'bytes':len(b)}for name,b in files.items()}}
 mb=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
 if manifest!=reference or mb!=reference_bytes:raise ValueError('Generated full manifest or source content drifted from the first freeze')
 expected=reference['artifactInventory']
 if set(files)!=set(expected):raise ValueError('Generated source artifact inventory changed')
 for name,data in files.items():
  if sha(data)!=expected[name]['sha256']or len(data)!=expected[name]['bytes']:raise ValueError('Generated source pixels changed: '+name)
 files['manifest.json']=mb
 # All images, glyph geometry, fonts, negative and probe validation finish before any output path exists.
 out.mkdir(parents=True,exist_ok=False)
 for name,b in files.items():
  target=out/name;target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('xb')as f:f.write(b)
 return manifest
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out-dir',required=True,type=Path);p.add_argument('--design',type=Path,default=FIXTURES/'design.json');p.add_argument('--reference-manifest',type=Path,default=FIXTURES/'manifest.json')
 for key in ['bold','regular','cjk','zh']:p.add_argument('--'+key+'-font',type=Path)
 a=p.parse_args();m=generate(a.out_dir,a.design,{k:getattr(a,k+'_font')for k in ['bold','regular','cjk','zh']if getattr(a,k+'_font')},a.reference_manifest)
 print(json.dumps({'scenes':len(m['fixtures']),'anchors':sum(len(f['expectedAnchors'])for f in m['fixtures']),'manifestSha256':sha((a.out_dir/'manifest.json').read_bytes()),'sourcePngBytes':sum(f['bytes']for f in m['fixtures'])},indent=2))
