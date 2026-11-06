/** Offline, reproducible alpha preparation. RGB source artwork is never rewritten.
 * npm install --prefix <isolated-tools> sharp; set SHARP_MODULE to its entry path.
 * node tools/prepare-alpha.mjs --model /path/isnetis.onnx --python /path/python
 * Optional --pose front --out /path/trial only prepares a single-pose experiment.
 */
import {readFile,writeFile,mkdir,mkdtemp,rm,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const args=Object.fromEntries(process.argv.slice(2).reduce((entries,value,index,array)=>index%2?entries:[...entries,[value,array[index+1]]],[]));
const root=resolve(args['--root']||fileURLToPath(new URL('..',import.meta.url)));
const out=resolve(args['--out']||join(root,'assets/short-hair-alpha-v1'));
const previewOut=resolve(args['--preview-dir']||join(out,'validation'));
const python=args['--python']||'python3',model=args['--model'];
if(!model)throw new Error('Pass --model with the pinned local isnetis.onnx.');
const sharp=(await import(process.env.SHARP_MODULE||'sharp')).default;
const digest=data=>createHash('sha256').update(data).digest('hex');
const modelHash='f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99';
if(digest(await readFile(model))!==modelHash)throw new Error('The ONNX weights do not match the registered author revision.');
const entries=[
  ['front','assets/short-hair-v1/front.png',[[0,790],[420,790],[470,804],[650,804],[700,790],[1122,790]]],
  ['view-left','assets/short-hair-v1/view-left.png',[[0,778],[405,778],[510,797],[703,797],[770,778],[1122,778]]],
  ['view-right','assets/short-hair-v1/view-right.png',[[0,788],[370,788],[435,809],[635,809],[745,788],[1122,788]]],
  ['view-left-up','assets/short-hair-v1/view-left-up.png',[[0,790],[390,790],[486,811],[706,811],[777,790],[1122,790]]],
  ['view-right-up','assets/short-hair-v1/view-right-up.png',[[0,790],[360,790],[430,813],[650,813],[760,790],[1122,790]]],
  ['view-left-down','assets/short-hair-v1/view-left-down.png',[[0,790],[390,790],[490,812],[700,812],[780,790],[1122,790]]],
  ['view-up','assets/short-hair-complete-poses-v1/view-up-neutral.png',[[0,790],[405,790],[465,808],[655,808],[720,790],[1122,790]]],
  ['view-down','assets/short-hair-complete-poses-v1/view-down-neutral.png',[[0,790],[405,790],[465,808],[655,808],[720,790],[1122,790]]],
  ['view-right-down','assets/short-hair-complete-poses-v1/view-right-down-neutral.png',[[0,784],[350,784],[438,807],[645,807],[750,784],[1122,784]]],
];
const selected=args['--pose']?entries.filter(([id])=>id===args['--pose']):entries;
if(!selected.length)throw new Error('Unknown pose');
await mkdir(out,{recursive:true});
await mkdir(previewOut,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'moemotion-alpha-'));
const poses={};
try{
 for(const [id,path,neckline]of selected){
  const original=await readFile(join(root,path)),info=await sharp(original).metadata();
  if(info.width!==1122||info.height!==1402)throw new Error(`${id}: unexpected source dimensions`);
  const h=1024,w=Math.floor(1024*1122/1402),left=Math.floor((1024-w)/2);
  const resized=await sharp(original).removeAlpha().resize(w,h,{kernel:'linear'}).raw().toBuffer();
  const input=new Float32Array(3*1024*1024);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)input[c*1024*1024+y*1024+left+x]=resized[(y*w+x)*3+c]/255;
  const inputPath=join(temporary,'input.f32'),outputPath=join(temporary,'output.f32');
  await writeFile(inputPath,Buffer.from(input.buffer));
  const inference=spawnSync(python,[join(root,'tools/infer-alpha.py'),'--model',resolve(model),'--input',inputPath,'--output',outputPath],{encoding:'utf8',maxBuffer:1024*1024});
  if(inference.status!==0)throw new Error(`Inference failed: ${inference.stderr||inference.stdout}`);
  const predictionBuffer=await readFile(outputPath),prediction=new Float32Array(predictionBuffer.buffer,predictionBuffer.byteOffset,predictionBuffer.byteLength/4);
  if(prediction.length!==1024*1024)throw new Error('Unexpected prediction size');
  const maskSmall=Buffer.alloc(1024*1024);
  for(let i=0;i<maskSmall.length;i++){
   const v=prediction[i];if(!Number.isFinite(v))throw new Error('Nonfinite mask');
   maskSmall[i]=v<.005?0:v>.995?255:Math.round(Math.min(1,Math.max(0,v))*255);
  }
  const mask=await sharp(maskSmall,{raw:{width:1024,height:1024,channels:1}}).extract({left,top:0,width:w,height:h}).resize(1122,1402,{kernel:'linear'}).extractChannel(0).raw().toBuffer();
  if(mask.length!==1122*1402)throw new Error('Expected one byte per alpha pixel');
  const alphaRGBA=Buffer.alloc(1122*1402*4,255),counts={transparent:0,opaque:0,edge:0};
  for(let i=0;i<mask.length;i++){alphaRGBA[i*4+3]=mask[i];counts[mask[i]===0?'transparent':mask[i]===255?'opaque':'edge']++;}
  const matte=await sharp(alphaRGBA,{raw:{width:1122,height:1402,channels:4}}).png().toBuffer();
  const filename=`${id}-matte.png`;await writeFile(join(out,filename),matte);
  const rgba=await sharp(original).ensureAlpha().raw().toBuffer();
  for(let i=0;i<mask.length;i++)rgba[i*4+3]=mask[i];
  const cutout=await sharp(rgba,{raw:{width:1122,height:1402,channels:4}}).png().toBuffer();
  const bgColors=['#161a24','#ffffff','#dd2fbd'];
  const comparisons=await Promise.all(bgColors.map(async background=>({input:await sharp(cutout).flatten({background}).resize(320,400).png().toBuffer()})));
  const panels=[{input:await sharp(original).resize(320,400).png().toBuffer(),left:0,top:0},...comparisons.map((entry,index)=>({...entry,left:320*(index+1),top:0}))];
  await sharp({create:{width:1280,height:400,channels:3,background:'#fff'}}).composite(panels).png().toFile(join(previewOut,`${id}-comparison.png`));
  poses[id]={source:`./${path}`,sourceSha256:digest(original),sourceBytes:original.length,
   matte:`./assets/short-hair-alpha-v1/${filename}`,matteSha256:digest(matte),matteBytes:matte.length,
   neckline,coverage:counts,inference:JSON.parse(inference.stdout.trim().split('\n').at(-1))};
  console.log(JSON.stringify({id,...counts,...poses[id].inference}));
 }
 const manifest={schemaVersion:1,id:'short-hair-alpha-v1',status:'derived-candidate',width:1122,height:1402,
  model:{name:'SkyTNT anime-seg ISNet',repository:'https://github.com/SkyTNT/anime-segmentation',
   weights:'https://huggingface.co/skytnt/anime-seg/resolve/493cb60893f47441b26ec4fb9a306bce9e342982/isnetis.onnx',
   revision:'493cb60893f47441b26ec4fb9a306bce9e342982',sha256:modelHash,license:'Apache-2.0'},
  processing:{input:'RGB / 255; 1024 square letterbox; NCHW float32',output:'mask only; source RGB is unchanged',
   maskEdge:'clamp probabilities below 0.005 to 0 and above 0.995 to 1, resize bilinear, quantize alpha to 8-bit',
   layers:'head and torso partition visible pixels at the registered neckline; feature layers remain authored replacement patches'},
  layers:[{id:'character',kind:'character-matte'},{id:'head',kind:'visible-partition'},{id:'torso',kind:'visible-partition'},
   ...['eyeLeft','eyeRight','browLeft','browRight','mouth'].map(id=>({id,kind:'authored-replacement-patch'}))],
  limitations:['Hidden anatomy and cloth behind the head are not completed.','Hair and face remain together in the visible head layer.','Fine edge alpha is model-derived and does not add user artwork approval.'],poses};
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 if(args['--license']&&resolve(args['--license'])!==join(out,'LICENSE-anime-seg.txt'))await copyFile(args['--license'],join(out,'LICENSE-anime-seg.txt'));
}finally{await rm(temporary,{recursive:true,force:true});}
