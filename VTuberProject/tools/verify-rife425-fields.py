"""Full grid candidate build and validation, work-only. No runtime mutation."""
from pathlib import Path
import sys,json,time,importlib.util,statistics,argparse
CODE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
for name in ['project','model-directory','baseline-weights','output']:parser.add_argument('--'+name,type=Path,required=True)
args=parser.parse_args()
PROJECT=args.project.resolve();ROOT=args.output.resolve();MODEL=args.model_directory.resolve()
if ROOT==PROJECT or PROJECT in ROOT.parents:raise ValueError('Validation output must be outside the project')
ROOT.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(args.baseline_weights.resolve()))
import numpy as np
import torch
from PIL import Image,ImageDraw

def load_module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
compiler=load_module('rife425_compiler',CODE/'compile-rife425-fields.py')
oldcompiler=load_module('rife46_compiler',CODE/'compile-rife-fields.py')
compiler.validate_model_files(MODEL)
warp=load_module('verified_rife425_warp',MODEL/'model/warplayer.py').warp
torch.set_num_threads(4);torch.set_num_interop_threads(1);torch.set_grad_enabled(False)
DEST=ROOT/'full-candidate';PREVIEWS=ROOT/'full-previews';PREVIEWS.mkdir(exist_ok=True)
pack=json.loads((PROJECT/'assets/short-hair-v1/character-pack.json').read_text())
full={};alpha={};native={};smallalpha={};source_hashes={}
for pose in pack['poses']:
 name=pose['id'];path=PROJECT/pose['reference']['path'];source_hashes[name]=compiler.sha256(path.read_bytes())
 full[name]=np.asarray(Image.open(path).convert('RGB'),np.float32).transpose(2,0,1)/255
 alpha[name]=np.asarray(Image.open(PROJECT/f'assets/short-hair-alpha-v1/{name}-matte.png').getchannel('A'),np.float32)[None]/255
 smallalpha[name]=compiler.resize_plane(alpha[name][0],(576,720))>.1
 rgba=np.concatenate([full[name]*alpha[name],alpha[name]],axis=0)
 native[name]=torch.from_numpy(np.ascontiguousarray(rgba)).unsqueeze(0)
old=oldcompiler.Rife(args.baseline_weights.resolve(),4)
report={'schemaVersion':1,'kind':'RIFE 4.25 full-grid candidate validation','productionModified':False,
 'scope':'16 edges x 7 times, both directions for symmetry, original RGB and alpha read-only',
 'proxyCaveat':'No ground-truth inbetweens. Symmetry/fold/error proxies cannot establish artistic correctness.',
 'inferenceResolution':[576,720],'runtimeResolution':[1122,1402],'fieldSize':[144,180],
 'nativeComparison':'Warp original native premultiplied RGBA twice: with full inference-resolution fields, then with stored float16/R8 fields. Measure their difference; this is compression loss, not ground-truth quality.',
 'cases':[]}
images={}

def inflate(flow,mask,size):
 # flow is channel-first inference pixels; map to native pixel displacement.
 fw,fh=size
 return np.stack([compiler.resize_plane(flow[c]/(576 if c%2==0 else 720),size)*(fw if c%2==0 else fh) for c in range(4)]),compiler.resize_plane(mask[0],size)[None]

def decoded(encoded_flow,encoded_mask,size):
 fw,fh=size
 return np.stack([compiler.resize_plane(encoded_flow[:,:,c].astype(np.float32),size)*(fw if c%2==0 else fh) for c in range(4)]),compiler.resize_plane(encoded_mask.astype(np.float32)/255,size)[None]

def render_native(first,second,flow,mask):
 f=torch.from_numpy(np.ascontiguousarray(flow)).unsqueeze(0);m=torch.from_numpy(np.ascontiguousarray(mask)).unsqueeze(0)
 with torch.inference_mode():r=warp(native[first],f[:,:2])*m+warp(native[second],f[:,2:])*(1-m)
 return r[0].numpy().copy()

def flow_proxy(flow,mask,subject):
 items=[]
 for i in range(2):
  dx,dy=flow[i*2:i*2+2];dxdy,dxdx=np.gradient(dx);dydy,dydx=np.gradient(dy)
  det=(1+dxdx)*(1+dydy)-dxdy*dydx
  active=subject & (mask[0]>.1 if i==0 else mask[0]<.9)
  items.append({'foldFraction':float(np.mean(det[active]<=0)),'jacobianP01':float(np.quantile(det[active],.01)),
   'jacobianP99':float(np.quantile(det[active],.99)),'displacementP95Px':float(np.quantile(np.hypot(dx,dy)[active],.95))})
 return items

def check(first,second,t,result,ef,em,inputs,model):
 a,b=inputs[first],inputs[second];subject=smallalpha[first]|smallalpha[second]
 start=time.perf_counter();oldout=old.infer(a,b,t,include_output=True);oldtime=time.perf_counter()-start
 oldresult={'flow':oldout['327'],'mask':oldout['332'],'rgb':oldout['out0']}
 of,om=compiler.encode_fields(oldresult)
 start=time.perf_counter();reverse425=model.infer(b,a,1-t);rt425=time.perf_counter()-start
 start=time.perf_counter();ro=old.infer(b,a,1-t,include_output=True);rt46=time.perf_counter()-start
 reverse46={'flow':ro['327'],'mask':ro['332'],'rgb':ro['out0']}
 case={'from':first,'to':second,'time':t,'models':{}}
 nativeSubject=(alpha[first][0]>.1)|(alpha[second][0]>.1)
 for name,r,reverse,f,m,reverse_time in [('rife46',oldresult,reverse46,of,om,rt46),('rife425',result,reverse425,ef,em,rt425)]:
  flow,mask,out=r['flow'],r['mask'],r['rgb']
  recon=oldcompiler.warp(a,flow[:2])*mask+oldcompiler.warp(b,flow[2:])*(1-mask)
  quantflow,quantmask=decoded(f,m,(576,720))
  quant=oldcompiler.warp(a,quantflow[:2])*quantmask+oldcompiler.warp(b,quantflow[2:])*(1-quantmask)
  fullflow,fullmask=inflate(flow,mask,(1122,1402));exactNative=render_native(first,second,fullflow,fullmask)
  cf,cm=decoded(f,m,(1122,1402));runtimeNative=render_native(first,second,cf,cm)
  error=np.abs(exactNative-runtimeNative);faceError=error[:3,270:870,200:980]
  stats={'fullFieldReconstructionMAE':float(np.abs(recon-out).mean()),
   'fullFieldInteriorMAE':float(np.abs(recon-out)[:,32:-32,32:-32].mean()),
   'compressedInferenceSubjectMAE':float(np.abs(quant-out)[:,subject].mean()),
   'nativeCompressionPremulRGBMAE':float(error[:3].mean()),
   'nativeCompressionSubjectPremulRGBMAE':float(error[:3,nativeSubject].mean()),
   'nativeCompressionFacePremulRGBMAE':float(faceError.mean()),
   'nativeCompressionAlphaMAE':float(error[3].mean()),
   'nativeCompressionRGBAErrorP99':float(np.quantile(error,.99)),
   'nativeCompressionRGBAErrorMax':float(error.max()),
   'reverseSubjectRGBMAE':float(np.abs(out-reverse['rgb'])[:,subject].mean()),
   'reverseFlowMAEPx':float(np.abs(flow-reverse['flow'][[2,3,0,1]]).mean()),
   'reverseMaskComplementMAE':float(np.abs(mask-(1-reverse['mask'])).mean()),
   'reverseInferenceSeconds':reverse_time,
   'flowProxy':flow_proxy(flow,mask,subject),
   'finite':bool(np.isfinite(runtimeNative).all()),'alphaRange':[float(runtimeNative[3].min()),float(runtimeNative[3].max())]}
  if name=='rife46':stats['inferenceSeconds']=oldtime
  case['models'][name]=stats
  if t==.5:
   yy,xx=np.mgrid[:1402,:1122];checker=np.where((xx//24+yy//24)%2,.82,.94).astype(np.float32)
   shown=runtimeNative[:3]+checker[None]*(1-runtimeNative[3:]);im=Image.fromarray(np.rint(np.clip(shown.transpose(1,2,0),0,1)*255).astype('uint8'))
   im.save(PREVIEWS/f'{first}--{second}-{name}-native.png');images[(first,second,name)]=im
 report['cases'].append(case);(ROOT/'full-validation.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'edge':first+'--'+second,'t':t,'symmetry':{k:round(v['reverseSubjectRGBMAE'],5) for k,v in case['models'].items()},'nativeFaceCompression':{k:round(v['nativeCompressionFacePremulRGBMAE'],5) for k,v in case['models'].items()}}),flush=True)

try:manifest=compiler.compile_fields(PROJECT,MODEL,DEST,4,check)
finally:old.close()
for c in report['cases']:
 e=next(e for e in manifest['edges'] if e['from']==c['from'] and e['to']==c['to'])
 c['models']['rife425']['inferenceSeconds']=e['inferenceSeconds'][compiler.TIMES.index(c['time'])]
metrics=['inferenceSeconds','reverseSubjectRGBMAE','reverseFlowMAEPx','nativeCompressionSubjectPremulRGBMAE','nativeCompressionFacePremulRGBMAE','nativeCompressionAlphaMAE','nativeCompressionRGBAErrorP99','fullFieldInteriorMAE']
def distribution(cases,name,key):
 ranked=sorted(cases,key=lambda c:c['models'][name][key]);values=[c['models'][name][key] for c in ranked]
 return {'mean':statistics.mean(values),'median':statistics.median(values),'p95':float(np.quantile(values,.95)),
 'worst':{'value':values[-1],'from':ranked[-1]['from'],'to':ranked[-1]['to'],'time':ranked[-1]['time']}}
report['distributions']={name:{key:distribution(report['cases'],name,key) for key in metrics} for name in ['rife46','rife425']}
report['edges']=[]
for first,second in compiler.EDGES:
 cases=[c for c in report['cases'] if c['from']==first and c['to']==second]
 row={'from':first,'to':second,'models':{name:{key:distribution(cases,name,key) for key in metrics} for name in ['rife46','rife425']}}
 report['edges'].append(row)
report['allFinite']=all(v['finite'] for c in report['cases'] for v in c['models'].values())
report['originalsStillUnchanged']=all(compiler.sha256((PROJECT/p['reference']['path']).read_bytes())==source_hashes[p['id']] for p in pack['poses'])
report['fieldBytes']=sum(e[k]['bytes'] for e in manifest['edges'] for k in ['flow','mask'])
report['manifestSha256']=compiler.sha256((DEST/'manifest.json').read_bytes())
report['sourceHashes']=source_hashes
for page in range(4):
 sheet=Image.new('RGB',(960,4*400),(245,245,245));draw=ImageDraw.Draw(sheet)
 for row,(first,second) in enumerate(compiler.EDGES[page*4:page*4+4]):
  for col,name in enumerate(['rife46','rife425']):
   im=images[(first,second,name)].crop((200,270,980,870)).resize((480,369),Image.Resampling.LANCZOS)
   sheet.paste(im,(col*480,row*400+31));draw.text((col*480+8,row*400+9),f'{first} -> {second} | {name} | t=.5',fill=(20,20,20))
 sheet.save(ROOT/f'full-face-contact-{page+1}.png')
(ROOT/'full-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('COMPLETE',json.dumps({'cases':len(report['cases']),'allFinite':report['allFinite'],'originalsStillUnchanged':report['originalsStillUnchanged'],'fieldBytes':report['fieldBytes'],'distributions':report['distributions']}),flush=True)
