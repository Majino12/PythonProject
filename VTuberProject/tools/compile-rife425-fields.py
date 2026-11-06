#!/usr/bin/env python3
"""Compile official RIFE 4.25 into the existing 2D motion-field protocol.

Source art is read-only. Model weights and inference code are checked against the
reviewed official bytes before either code execution or weights-only loading.
Requires Python 3.12, torch==2.9.1, numpy==2.3.5, Pillow==13.0.0 for this receipt.
The default inference device is CPU; no neural code is shipped to the browser.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import types
import numpy as np
from PIL import Image
import torch

MODEL_COMMIT='bbfd2ea90910789a860ea3e2b32a240cd577b75e'
MODEL_URL='https://github.com/hzwer/Practical-RIFE'
WEIGHT_URL='https://drive.google.com/uc?export=download&id=1ZKjcbmt1hypiFprJPIKW0Tt0lr_2i7bg'
ARCHIVE_SHA256='e63d481b7ae5d4a4e6ad7ac5b410ff78f3bf7be3b51b2e38ca8152747abde5b4'
MODEL_HASHES={
 'train_log/flownet.pkl':'6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2',
 'train_log/IFNet_HDv3.py':'655b4c772b037967b86c2dd31c8fa3b5323b79dd9a0e0088708d89149bbc8a32',
 'model/warplayer.py':'feb3af9475b724749b023d1913c3b135431eff13d0045b8efb472a699058385f',
}
TIMES=[i/8 for i in range(1,8)]
GRID=[['view-left-up','view-up','view-right-up'],['view-left','front','view-right'],['view-left-down','view-down','view-right-down']]
EDGES=([(row[x],row[x+1]) for row in GRID for x in range(2)]+[(GRID[y][x],GRID[y+1][x]) for y in range(2) for x in range(3)]+[(GRID[y][x],GRID[y+1][x+1]) for y in range(2) for x in range(2)])

def sha256(data):return hashlib.sha256(data).hexdigest()
def resize_plane(plane,size):return np.asarray(Image.fromarray(plane.astype(np.float32)).resize(size,Image.Resampling.BILINEAR),dtype=np.float32)

def validate_model_files(directory):
 for relative,expected in MODEL_HASHES.items():
  if sha256((directory/relative).read_bytes())!=expected:raise ValueError(f'{relative}: expected pinned official RIFE 4.25 bytes')

class Rife425:
 def __init__(self,directory,threads=4):
  directory=Path(directory);validate_model_files(directory)
  torch.set_num_threads(threads)
  # Bind only the verified official warplayer. Do not import a user-supplied
  # model/__init__.py, train_log/__init__.py, or the training wrapper/loss stack.
  spec=importlib.util.spec_from_file_location('_verified_rife425_warp',directory/'model/warplayer.py')
  warp_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(warp_module)
  package=types.ModuleType('model');package.warplayer=warp_module
  prior={key:sys.modules.get(key) for key in ['model','model.warplayer']}
  sys.modules['model']=package;sys.modules['model.warplayer']=warp_module
  try:
   spec=importlib.util.spec_from_file_location('_verified_rife425_ifnet',directory/'train_log/IFNet_HDv3.py')
   module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  finally:
   for key,value in prior.items():
    if value is None:sys.modules.pop(key,None)
    else:sys.modules[key]=value
  self.model=module.IFNet().eval().to('cpu')
  weights=torch.load(directory/'train_log/flownet.pkl',map_location='cpu',weights_only=True)
  weights={key.removeprefix('module.'):value for key,value in weights.items()}
  expected=set(self.model.state_dict());self.ignored_training_keys=sorted(set(weights)-expected)
  if not all(key.startswith(('teacher.','caltime.')) for key in self.ignored_training_keys):raise ValueError('Unexpected checkpoint tensors')
  self.model.load_state_dict({key:value for key,value in weights.items() if key in expected},strict=True)
 def infer(self,a,b,t):
  if a.shape!=b.shape or len(a.shape)!=3 or a.shape[0]!=3 or not 0<t<1:raise ValueError('Expected matching RGB images and interior time')
  if not np.isfinite(a).all() or not np.isfinite(b).all():raise ValueError('Non-finite input')
  _,height,width=a.shape
  padding=((0,0),(0,(-height)%64),(0,(-width)%64))
  aa=torch.from_numpy(np.ascontiguousarray(np.pad(a,padding),dtype=np.float32)).unsqueeze(0)
  bb=torch.from_numpy(np.ascontiguousarray(np.pad(b,padding),dtype=np.float32)).unsqueeze(0)
  with torch.inference_mode():
   flows,logits,merged=self.model(torch.cat((aa,bb),1),t,[16,8,4,2,1],fastmode=True,ensemble=False)
   result={'flow':flows[-1][0,:,:height,:width].numpy().copy(),'mask':torch.sigmoid(logits)[0,:,:height,:width].numpy().copy(),'rgb':merged[-1][0,:,:height,:width].numpy().copy()}
  if not all(np.isfinite(value).all() for value in result.values()):raise RuntimeError('Non-finite candidate result')
  if result['flow'].shape!=(4,height,width) or result['mask'].shape!=(1,height,width) or result['rgb'].shape!=(3,height,width):raise RuntimeError('Unexpected candidate tensor shape')
  return result

def encode_fields(result):
 flow=np.stack([resize_plane(result['flow'][c]/(576 if c%2==0 else 720),(144,180)) for c in range(4)],axis=-1)
 if not np.isfinite(flow).all() or np.max(np.abs(flow))>2:raise RuntimeError('Unusable candidate displacement field')
 mask=resize_plane(result['mask'][0],(144,180))
 return flow.astype('<f2'),np.rint(np.clip(mask,0,1)*255).astype('uint8')

def compile_fields(project,model_directory,destination,threads=4,on_inference=None):
 project=Path(project).resolve();model_directory=Path(model_directory).resolve();destination=Path(destination).resolve()
 if project==destination or project in destination.parents:raise ValueError('Candidate compiler must write outside the project; integrate reviewed artifacts separately')
 pack=json.loads((project/'assets/short-hair-v1/character-pack.json').read_text())
 inputs={};sources={}
 for record in pack['poses']:
  relative=record['reference']['path'];path=project/relative
  sources[record['id']]={'path':relative,'sha256':sha256(path.read_bytes())}
  with Image.open(path) as image:
   if image.size!=(1122,1402):raise ValueError('Expected registered original canvas')
   inputs[record['id']]=np.asarray(image.convert('RGB').resize((576,720),Image.Resampling.LANCZOS),np.float32).transpose(2,0,1)/255
 destination.mkdir(parents=True,exist_ok=True)
 manifest={'schemaVersion':1,'id':'short-hair-rife-v4.25-fields-v1',
 'model':{'name':'RIFE v4.25','implementation':'hzwer/Practical-RIFE','commit':MODEL_COMMIT,'license':'MIT','weights':MODEL_HASHES,
 'url':f'{MODEL_URL}/tree/{MODEL_COMMIT}','weightArchiveUrl':WEIGHT_URL,'weightArchiveSha256':ARCHIVE_SHA256,
 'runtime':f'PyTorch {torch.__version__}, CPU float32, {threads} threads, no TTA','flowOutput':'flow_list[-1]','maskOutput':'sigmoid(mask_logits)','scaleList':[16,8,4,2,1]},
 'inferenceSize':[576,720],'padding':'right/bottom zero to multiples of 64','fieldSize':[144,180],'times':TIMES,
 'flowFormat':'little-endian float16, [time][y][x][dx0,dy0,dx1,dy1]','flowUnits':'normalized image UV displacement; positive y points down',
 'maskFormat':'uint8, [time][y][x], endpoint0 weight / 255','sampling':'pixel-centred bilinear; fields are downsampled from neural outputs',
 'endpoints':'source art is used exactly at t=0 and t=1','sources':sources,'edges':[]}
 model=Rife425(model_directory,threads);started=time.monotonic()
 for first,second in EDGES:
  flows=[];masks=[];timings=[]
  for t in TIMES:
   before=time.monotonic();result=model.infer(inputs[first],inputs[second],t);timings.append(time.monotonic()-before)
   flow,mask=encode_fields(result);flows.append(flow);masks.append(mask)
   if on_inference:on_inference(first,second,t,result,flow,mask,inputs,model)
  prefix=first+'--'+second;fb=np.stack(flows).tobytes(order='C');mb=np.stack(masks).tobytes(order='C')
  (destination/(prefix+'.flow.bin')).write_bytes(fb);(destination/(prefix+'.mask.bin')).write_bytes(mb)
  manifest['edges'].append({'id':first+'__'+second,'from':first,'to':second,'flow':{'path':prefix+'.flow.bin','bytes':len(fb),'sha256':sha256(fb)},
   'mask':{'path':prefix+'.mask.bin','bytes':len(mb),'sha256':sha256(mb)},'inferenceSeconds':[round(value,6) for value in timings]})
  print(f'{prefix}: 7 RIFE 4.25 samples, {sum(timings):.2f}s inference',flush=True)
 manifest['compilationSeconds']=round(time.monotonic()-started,3)
 manifest['validationHookUsed']=on_inference is not None
 (destination/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 return manifest

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--project',type=Path,required=True);parser.add_argument('--model-directory',type=Path,required=True)
 parser.add_argument('--output',type=Path,required=True);parser.add_argument('--threads',type=int,default=4,choices=range(1,33))
 args=parser.parse_args();compile_fields(args.project,args.model_directory,args.output,args.threads)
