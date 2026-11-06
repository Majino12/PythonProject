import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {validateShortHairAlphaManifest,SHORT_HAIR_ALPHA_POSES,applyShortHairAlpha,headOwnsPixel,createShortHairVisibleLayers,createShortHairLayerZip,compatibleShortHairExportState} from './short-hair-alpha.js';

const manifest=JSON.parse(await readFile(new URL('./assets/short-hair-alpha-v1/manifest.json',import.meta.url),'utf8'));
const sha=data=>createHash('sha256').update(data).digest('hex');
const clone=()=>structuredClone(manifest);

function pngRGBA(bytes){
 assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);assert.equal(bytes[24],8);assert.equal(bytes[25],6);
 let offset=8;const pieces=[];
 while(offset<bytes.length){const length=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);if(kind==='IDAT')pieces.push(bytes.subarray(offset+8,offset+8+length));offset+=length+12;}
 const raw=inflateSync(Buffer.concat(pieces)),stride=width*4,data=Buffer.alloc(stride*height);
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<height;y++){
  const filter=raw[y*(stride+1)];assert.ok(filter<=4);
  for(let x=0;x<stride;x++){
   const a=x>=4?data[y*stride+x-4]:0,b=y?data[(y-1)*stride+x]:0,c=y&&x>=4?data[(y-1)*stride+x-4]:0;
   data[y*stride+x]=(raw[y*(stride+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;
  }
 }
 return {width,height,data};
}

test('alpha manifest registers all nine masks and explicit derived status',()=>{
 assert.equal(validateShortHairAlphaManifest(manifest),manifest);assert.equal(manifest.status,'derived-candidate');
 assert.deepEqual(Object.keys(manifest.poses).sort(),[...SHORT_HAIR_ALPHA_POSES].sort());
 assert.ok(manifest.limitations.some(value=>value.includes('Hair and face')));
});
for(const [name,mutate]of [
 ['missing pose',m=>delete m.poses.front],['extra pose',m=>m.poses.unknown=m.poses.front],
 ['foreign mask URL',m=>m.poses.front.matte='https://example.com/mask.png'],
 ['source traversal',m=>m.poses.front.source='./assets/../private.png'],
 ['wrong size',m=>m.width=1024],['missing source checksum',m=>delete m.poses.front.sourceSha256],
 ['reversed neckline',m=>m.poses.front.neckline=[[0,800],[600,800],[500,800],[1122,800]]],
 ['truncated neckline',m=>m.poses.front.neckline=[[100,800],[1122,800]]],
 ['nonfinite neckline',m=>m.poses.front.neckline[1][1]=NaN],
])test(`alpha manifest rejects ${name}`,()=>{const m=clone();mutate(m);assert.throws(()=>validateShortHairAlphaManifest(m));});

for(const id of SHORT_HAIR_ALPHA_POSES)test(`${id} matte is verified RGBA with preserved solid interior and transparent background`,async()=>{
 const p=manifest.poses[id],bytes=await readFile(new URL(p.matte,import.meta.url)),source=await readFile(new URL(p.source,import.meta.url));
 assert.equal(bytes.length,p.matteBytes);assert.equal(sha(bytes),p.matteSha256);
 assert.equal(source.length,p.sourceBytes);assert.equal(sha(source),p.sourceSha256);
 const {width,height,data}=pngRGBA(bytes);assert.equal(width,1122);assert.equal(height,1402);
 const counts={transparent:0,opaque:0,edge:0};
 for(let i=0;i<data.length;i+=4){assert.equal(data[i],255);assert.equal(data[i+1],255);assert.equal(data[i+2],255);const a=data[i+3];counts[a===0?'transparent':a===255?'opaque':'edge']++;}
 assert.deepEqual(counts,p.coverage);assert.ok(counts.opaque>width*height*.5);assert.ok(counts.transparent>width*height*.2);assert.ok(counts.edge<width*height*.1);
 for(const [x,y]of [[10,10],[1110,10]])assert.equal(data[(y*width+x)*4+3],0);
 for(const [x,y]of [[560,650],[560,1300]])assert.equal(data[(y*width+x)*4+3],255);
});

test('neckline partition chooses exactly one visible layer at all boundaries',()=>{
 for(const p of Object.values(manifest.poses))for(let x=0;x<=1122;x+=7)for(let y=0;y<=1402;y+=7){const head=headOwnsPixel(p.neckline,x,y);assert.equal(typeof head,'boolean');assert.equal(Number(head)+Number(!head),1);}
 assert.equal(headOwnsPixel([[0,10],[10,20]],5,14.9),true);assert.equal(headOwnsPixel([[0,10],[10,20]],5,15),false);
 assert.equal(headOwnsPixel([[0,10],[10,20]],20,19),true);
 assert.throws(()=>headOwnsPixel([[0,10],[10,20]],NaN,0));
});

test('matte application uses source crop and restores compositing state',()=>{
 const calls=[],ctx={save(){calls.push(['save']);},setTransform(...a){calls.push(['transform',...a]);},drawImage(...a){calls.push(['draw',...a]);},restore(){calls.push(['restore']);}};
 const canvas={width:1280,height:720,getContext:()=>ctx},matte={width:1122,height:1402};
 const assets={manifest,mattes:{front:matte}};applyShortHairAlpha(canvas,assets,'front',[245,350,630,460]);
 assert.equal(ctx.globalCompositeOperation,'destination-in');assert.equal(ctx.globalAlpha,1);
 assert.deepEqual(calls[2],['draw',matte,245,350,630,460,0,0,1280,720]);assert.deepEqual(calls.at(-1),['restore']);
 assert.throws(()=>applyShortHairAlpha(canvas,assets,'unknown'));assert.throws(()=>applyShortHairAlpha(canvas,assets,'front',[0,0,2000,500]));
});

test('visible layer export preserves alpha exactly and partitions without seams',()=>{
 const previous=globalThis.document;
 const makeCanvas=()=>{const canvas={width:2,height:2,pixels:null};canvas.getContext=()=>({drawImage(other){canvas.pixels=new Uint8ClampedArray(other.pixels);},getImageData(){return {data:canvas.pixels};},createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(image){canvas.pixels=image.data;}});return canvas;};
 globalThis.document={createElement:makeCanvas};
 try{
  const input=makeCanvas();input.pixels=new Uint8ClampedArray([12,34,56,255,78,90,12,130,34,56,78,20,90,12,34,255]);
  const layers=createShortHairVisibleLayers(input,{manifest,mattes:{front:{}}},'front',{alphaApplied:true});
  for(let i=0;i<input.pixels.length;i+=4){assert.equal(layers.head.pixels[i+3]+layers.torso.pixels[i+3],input.pixels[i+3]);for(let c=0;c<3;c++){assert.equal(layers.head.pixels[i+c],input.pixels[i+c]);assert.equal(layers.torso.pixels[i+c],input.pixels[i+c]);}}
  assert.equal(layers.head.pixels[3],255);assert.equal(layers.torso.pixels[15],255);
 }finally{globalThis.document=previous;}
});

test('layer ZIP stores correct filenames, offsets and the standard CRC32 vector',()=>{
 const bytes=createShortHairLayerZip([{name:'check.txt',data:new TextEncoder().encode('123456789')},{name:'layers.json',data:new TextEncoder().encode('{}')}]);
 const view=new DataView(bytes.buffer),local1=30+9+9,central=local1+30+11+2;
 assert.equal(view.getUint32(0,true),0x04034b50);assert.equal(view.getUint32(14,true),0xcbf43926);
 assert.equal(new TextDecoder().decode(bytes.slice(30,39)),'check.txt');assert.equal(new TextDecoder().decode(bytes.slice(39,48)),'123456789');
 assert.equal(view.getUint32(local1,true),0x04034b50);assert.equal(view.getUint32(central,true),0x02014b50);
 assert.equal(view.getUint32(central+46+9+42,true),local1);
 const end=bytes.length-22;assert.equal(view.getUint32(end,true),0x06054b50);assert.equal(view.getUint16(end+10,true),2);assert.equal(view.getUint32(end+16,true),central);
});
test('layer ZIP rejects nested/traversal paths, executable extensions and duplicates',()=>{
 const data=new Uint8Array([1]);
 for(const name of ['../x.png','dir/x.png','script.js','/root.png'])assert.throws(()=>createShortHairLayerZip([{name,data}]));
 assert.throws(()=>createShortHairLayerZip([{name:'x.png',data},{name:'x.png',data}]));
});
test('layer export maps displayed states only when authored for the selected endpoint',()=>{
 const selected={eyeLeft:'open',eyeRight:'half',mouth:'neutral',browLeft:'innerUp',browRight:'neutral'};
 const patches={eyeLeft:{closed:{}},eyeRight:{half:{}},mouth:{parted:{}},browLeft:{innerUp:{}},browRight:{outerUp:{}}};
 const result=compatibleShortHairExportState(selected,{eyeLeft:'closed',eyeRight:'open',mouth:'parted',browLeft:'up',browRight:'outerUp'},{patches},patches);
 assert.deepEqual(result,{eyeLeft:'closed',eyeRight:'open',mouth:'parted',browLeft:'innerUp',browRight:'outerUp'});
 assert.deepEqual(compatibleShortHairExportState(selected,undefined,{patches},patches),selected);
 assert.throws(()=>compatibleShortHairExportState(selected,[],{patches},patches));
});
