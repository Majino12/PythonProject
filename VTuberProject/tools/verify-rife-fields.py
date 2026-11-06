from pathlib import Path
import argparse, json, importlib.util, time
parser=argparse.ArgumentParser(description='Compare exported fields with actual RIFE network inference and save contact sheets.')
parser.add_argument('--project',type=Path,required=True)
parser.add_argument('--weights',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
import numpy as np
from PIL import Image,ImageDraw
PROJECT=args.project.resolve()
spec=importlib.util.spec_from_file_location('compiler',PROJECT/'tools/compile-rife-fields.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
ASSETS=PROJECT/'assets/short-hair-motion-v1'
manifest=json.loads((ASSETS/'manifest.json').read_text())
results=[]
model=c.Rife(args.weights.resolve())
inputs={}
for name,source in manifest['sources'].items():
    im=Image.open(PROJECT/source['path']).convert('RGB').resize((576,720),Image.Resampling.LANCZOS)
    inputs[name]=np.asarray(im,np.float32).transpose(2,0,1)/255
OUTPUT=args.output.resolve()
OUTPUT.mkdir(parents=True,exist_ok=True)
panels=[]
try:
    for edge in manifest['edges']:
        a,b=inputs[edge['from']],inputs[edge['to']]
        f=np.frombuffer((ASSETS/edge['flow']['path']).read_bytes(),dtype='<f2').reshape(7,180,144,4).astype(np.float32)
        m=np.frombuffer((ASSETS/edge['mask']['path']).read_bytes(),dtype=np.uint8).reshape(7,180,144).astype(np.float32)/255
        thumbs=[a]
        for idx in [1,3,5]:
            t=manifest['times'][idx]
            flow=np.stack([c.resize_plane(f[idx,:,:,k],(576,720))*(576 if k%2==0 else 720) for k in range(4)])
            mask=c.resize_plane(m[idx],(576,720))[None]
            generated=c.warp(a,flow[:2])*mask+c.warp(b,flow[2:])*(1-mask)
            full=model.infer(a,b,t,include_output=True)
            diff=np.abs(generated-full['out0'])
            recon=c.warp(a,full['327'][:2])*full['332']+c.warp(b,full['327'][2:])*(1-full['332'])
            interior=(slice(None),slice(12,-12),slice(12,-12))
            entry={'edge':edge['id'],'time':t,'meanAbsoluteRGBError':float(diff.mean()),
                'p95AbsoluteRGBError':float(np.percentile(diff,95)),
                'maxAbsoluteRGBError':float(diff.max()),
                'fullFieldInteriorMeanError':float(np.abs(recon-full['out0'])[interior].mean()),
                'fullFieldInteriorMaxError':float(np.abs(recon-full['out0'])[interior].max())}
            results.append(entry);thumbs.append(generated)
            if edge['from']=='front' and edge['to']=='view-right' and t==.5:
                pair=Image.new('RGB',(1152,744),'white')
                for x,arr,label in [(0,full['out0'],'Actual neural output'),(576,generated,'Exported 144 x 180 fields')]:
                    pair.paste(Image.fromarray(np.uint8(np.clip(arr.transpose(1,2,0),0,1)*255)),(x,24))
                    ImageDraw.Draw(pair).text((x+8,6),label,fill='black')
                pair.save(OUTPUT/'v0.17-rife-model-vs-fields.png')
        thumbs.append(b)
        panel=Image.new('RGB',(5*180,258),'#f3f3f3');draw=ImageDraw.Draw(panel)
        draw.text((8,3),edge['from']+' > '+edge['to'],fill='black')
        for i,(arr,label) in enumerate(zip(thumbs,['source 0','t=.25','t=.50','t=.75','source 1'])):
            im=Image.fromarray(np.uint8(np.clip(arr.transpose(1,2,0),0,1)*255)).resize((180,225),Image.Resampling.LANCZOS)
            panel.paste(im,(i*180,31));draw.text((i*180+8,17),label,fill='black')
        panels.append(panel)
        print(edge['id'],flush=True)
finally:model.close()
for index in [0,1]:
    sheet=Image.new('RGB',(900,8*258),'white')
    for y,panel in enumerate(panels[index*8:(index+1)*8]):sheet.paste(panel,(0,y*258))
    sheet.save(OUTPUT/f'v0.17-rife-edges-{index+1}.jpg',quality=93)
report={'model':'RIFE v4.6','commit':manifest['model']['commit'],'edgeCount':16,
    'modelEvaluationsForCompilation':112,'compilationSeconds':manifest['compilationSeconds'],
    'evaluationsForValidation':len(results),'fieldSize':[144,180],'inferenceSize':[576,720],
    'method':'Re-run official NCNN network; compare its RGB out0 to normalized RGBA16F fields + R8 mask reconstructed at inference size.',
    'meanAbsoluteRGBErrorAcrossCases':float(np.mean([r['meanAbsoluteRGBError'] for r in results])),
    'worstCaseMeanAbsoluteRGBError':max(r['meanAbsoluteRGBError'] for r in results),
    'maxFullFieldInteriorMeanError':max(r['fullFieldInteriorMeanError'] for r in results),
    'cases':results,
    'limitations':['Low-resolution stored fields approximate full-resolution neural outputs.',
        'Network is conditioned on neutral art; expression overlays reuse those fields.',
        'Triangle interiors combine edge fields and are not direct three-view neural inference.',
        'Endpoint artwork differs in some details; inference does not repair inconsistent drawing.']}
(PROJECT/'validation/v0.17-rife-model.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='cases'}),flush=True)
