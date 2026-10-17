#!/usr/bin/env python3
"""Task identity hash checker. Only Booted phases use official container queries. No writes outside evidence."""
from pathlib import Path
import json,hashlib,plistlib,subprocess,sys
SHARED=Path(__file__).resolve().parent.parent;case=sys.argv[1];assert case=='inline-attempt1';P=SHARED/case;plan=json.loads((P/'plan.json').read_text());D=Path('/Users/thinkstu/Library/Developer/CoreSimulator/Devices')/plan['UDID']
mode=sys.argv[2];assert mode in ['before-boot','before-install','after-install','after-restore','after-shutdown']
sha=lambda q:hashlib.sha256(Path(q).read_bytes()).hexdigest()
def files(root):
 root=Path(root);assert root.is_dir() and not root.is_symlink();m={}
 for q in sorted(root.rglob('*')):
  assert not q.is_symlink(),str(q)
  if q.is_file():m[q.relative_to(root).as_posix()]=sha(q)
 return m
def query(bundle,kind):
 s=subprocess.check_output(['/usr/bin/xcrun','simctl','get_app_container',plan['UDID'],bundle,kind],text=True,timeout=15).strip();q=Path(s)
 typ='Bundle' if kind=='app' else 'Data';assert str(q).startswith(str(D/'data/Containers'/typ/'Application')+'/');assert not q.is_symlink();return q
def metadata(bundle,kind):
 found=[]
 if kind=='app':
  for q in (D/'data/Containers/Bundle/Application').glob('*/*.app'):
   assert not q.is_symlink();f=q/'Info.plist'
   if f.is_file() and plistlib.loads(f.read_bytes()).get('CFBundleIdentifier')==bundle:found.append(q)
 else:
  for q in (D/'data/Containers/Data/Application').iterdir():
   f=q/'.com.apple.mobile_container_manager.metadata.plist'
   if q.is_dir() and f.is_file() and plistlib.loads(f.read_bytes()).get('MCMMetadataIdentifier')==bundle:found.append(q)
 assert len(found)==1,(bundle,kind,len(found));return found[0]
def identity(which):
 q=Path(plan[which+'Identity']);assert sha(q)==plan[which+'IdentitySHA256'];j=json.loads(q.read_text());assert j['bundleId']==plan['bundle'];assert files(j['app'])==j['allFileSHA256'];return j
assert plan['status']=='FROZEN_PRODUCTION_IDENTITY_PENDING_ROOT_SERIAL_GO'
assert plan['artifactKind']=='production';old,new=identity('old'),identity('new');assert len(old['allFileSHA256'])==485;assert new['webFiles']==plan['newWebFiles'] and new['webRawSha256']==plan['newWebRawSHA256'];assert len(new['allFileSHA256'])==plan['newAppFiles'];assert not any('research-video-dom-' in n for n in new['allFileSHA256']);assert new['runtimeCommit']==plan['runtimeCommit'];assert new['guideSha256']==plan['newGuideSHA256'];assert new['webRecordSha256']==plan['newWebRecordSHA256'];assert new['nativeSha256']==plan['newNativeSHA256']
us=plan['Userscripts'];assert sha(us['source'])==us['sourceSHA256'];assert files(us['app'])==us['allFileSHA256'] and len(us['allFileSHA256'])==47
cfg=plistlib.loads((D/'device.plist').read_bytes());assert cfg['UDID']==plan['UDID'] and cfg['name']==plan['name']
# No get_app_container call after Shutdown; rehash only official paths resolved after successful restore.
if mode=='after-shutdown':
 prior=json.loads((P/'identity-after-restore.json').read_text())
 app=Path(prior['FR']['app']);uapp=Path(prior['Userscripts']['app']);data=Path(prior['FRPrivate']['container']);demo=Path(prior['Demo']['path'])
else:
 resolve=metadata if mode=='before-boot' else query
 app=resolve(plan['bundle'],'app');uapp=resolve(us['bundleId'],'app');data=resolve(plan['bundle'],'data');demo=resolve(us['bundleId'],'data')/'Documents/Demo_user_script.user.js'
expected=new if mode=='after-install' else old
assert files(app)==expected['allFileSHA256'],'Installed FR full identity mismatch';assert files(uapp)==us['allFileSHA256'],'Userscripts47 mismatch'
private=files(data);assert demo.is_file() and not demo.is_symlink();assert sha(demo)=='6eb20314a7463f8f210cb1ced63867b1f2e3537ce66d7f12d106641d040d14b3'
r={'mode':mode,'FR':{'app':str(app),'allCompiledFilesMatch':True,'fileCount':len(expected['allFileSHA256']),'nativeSHA256':expected['nativeSha256'],'webRawSHA256':expected['webRawSha256']},'Userscripts':{'app':str(uapp),'all47Match':True},'FRPrivate':{'container':str(data),'allFileSHA256':private,'fileCount':len(private),'scope':plan['privateBoundary']},'Demo':{'path':str(demo),'sha256':sha(demo)},'officialContainerQueries':mode not in ['before-boot','after-shutdown']}
if mode=='before-boot':assert len(private)==17,'Fresh FR native private baseline differs from known17; inspect before boot'
else:
 b=json.loads((P/'identity-before-boot.json').read_text());r['FRPrivate'].update(dataContainerUUIDMigrated=str(data)!=b['FRPrivate']['container'],same17FileContent=private==b['FRPrivate']['allFileSHA256'],changes=[{'path':f,'beforeSHA256':b['FRPrivate']['allFileSHA256'].get(f),'afterSHA256':private.get(f)} for f in sorted(set(private)|set(b['FRPrivate']['allFileSHA256'])) if private.get(f)!=b['FRPrivate']['allFileSHA256'].get(f)])
 if mode in ['before-install','after-install']:assert r['FRPrivate']['same17FileContent'],'Pre-UI native private baseline changed'
with (P/('identity-'+mode+'.json')).open('x') as out:json.dump(r,out,ensure_ascii=False,indent=2);out.write('\n')
print(json.dumps({'mode':mode,'FRFiles':r['FR']['fileCount'],'US47':True,'privateFiles':len(private),'same17Content':r['FRPrivate'].get('same17FileContent'),'containerMigrated':r['FRPrivate'].get('dataContainerUUIDMigrated')}))
