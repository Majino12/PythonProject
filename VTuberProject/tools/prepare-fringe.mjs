// Offline compiler. Install sharp 0.35.5 in an isolated tools environment.
const sharp=(await import(process.env.SHARP_MODULE||'sharp')).default;
import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';
import {decomposeFringeLayers,squaredDistanceToOwnership} from '../short-hair-fringe-decomposition.js';
import {createHairMeshBinding,serializeHairMeshBinding} from '../short-hair-mesh-model.js';
const args={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--root','--out','--pose'].includes(k)||!v||Object.hasOwn(args,k))throw Error('Use --out DIR [--root PROJECT] [--pose ID].');args[k]=v;}
const review=path.resolve(args['--root']||fileURLToPath(new URL('..',import.meta.url))),pack=path.join(review,'assets/short-hair-fringe-v1'),root=path.join(pack,'build-inputs');
if(!args['--out'])throw Error('--out is required; generate a review directory before replacing any registered assets.');
const out=path.resolve(args['--out']);if(out===pack||out.startsWith(pack+path.sep))throw Error('Build output must be outside the registered source pack.');await fs.mkdir(out,{recursive:true});
const alpha=JSON.parse(await fs.readFile(review+'/assets/short-hair-alpha-v1/manifest.json','utf8'));
const config=JSON.parse(await fs.readFile(root+'/build-config.json','utf8'));
const manifest=JSON.parse(await fs.readFile(pack+'/manifest.json','utf8'));const registered=manifest.poses;manifest.poses={};
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async p=>await sharp(p).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const inside=(x,y,p)=>{let c=false;for(let i=0,j=p.length-1;i<p.length;j=i++)if((p[i][1]>y)!=(p[j][1]>y)&&x<(p[j][0]-p[i][0])*(y-p[i][1])/(p[j][1]-p[i][1])+p[i][0])c=!c;return c;};
for(const id of args['--pose']?[args['--pose']]:Object.keys(config.poses)){
 const record=alpha.poses[id];if(!record)throw Error(id);const sr=review+'/'+record.source.slice(2),upr=root+'/'+config.poses[id].underpaint;
 if(sha(await fs.readFile(sr))!==record.sourceSha256||sha(await fs.readFile(upr))!==config.poses[id].underpaintSha256||sha(await fs.readFile(review+'/'+record.matte.slice(2)))!==record.matteSha256)throw Error(id+' registered build-input hash mismatch');
 const hp=pack+'/'+id+'-hairOwnership.png';if(sha(await fs.readFile(hp))!==registered[id]?.hairOwnership.sha256)throw Error(id+' whole-hair input hash mismatch');
 const [s,u,m,a]=await Promise.all([sr,upr,hp,review+'/'+record.matte.slice(2)].map(read));
 const {width:w,height:h}=s.info,n=w*h;for(const v of[u,m,a])if(v.info.width!==w||v.info.height!==h)throw Error(id+' dimensions');
 const semantic=config.poses[id].semanticProtection,protectedPolygons=[...semantic.protectedBrowPolygons,...semantic.protectedEyePolygons];
 const skin=new Uint8Array(n),reachable=new Uint8Array(n),queue=new Int32Array(n);let head=0,tail=0;
 for(let i=0;i<n;i++)skin[i]=+(u.data[i*4]-u.data[i*4+2]>12&&u.data[i*4]>120);
 const visit=i=>{if(i>=0&&i<n&&!skin[i]&&!reachable[i]){reachable[i]=1;queue[tail++]=i;}};
 for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
 while(head<tail){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}for(let i=0;i<n;i++)if(!reachable[i])skin[i]=1;
 const H=new Uint8Array(n),A=new Uint8Array(n),allowed=new Uint8Array(n).fill(255);let clipped=0;
 for(let i=0;i<n;i++){const k=i*4,x=i%w,y=Math.floor(i/w),protectedPixel=y<760&&protectedPolygons.some(p=>inside(x+.5,y+.5,p));A[i]=a.data[k+3];if(protectedPixel)allowed[i]=0;
  const roi=id==='front'?x>=270&&x<850&&y>=240&&y<660:x>=180&&x<930&&y>=180&&y<730;
  if(roi&&m.data[k]>=128&&skin[i]&&!protectedPixel){if(A[i]===255)H[i]=255;else clipped++;}}
 const nonOpaque=Uint8Array.from(A,v=>v<255?255:0),distance=squaredDistanceToOwnership(nonOpaque,w,h);for(let i=0;i<n;i++)if(distance[i]<81)allowed[i]=0;
 const result=decomposeFringeLayers({source:s.data,underpaint:u.data,width:w,height:h,ownership:H,contactAllowed:allowed,characterAlpha:A,supportRadius:24,solidRadius:12});
 const dest=out+'/previews/'+id;await fs.mkdir(dest,{recursive:true});
 const png=async(data,name,channels=4)=>sharp(data,{raw:{width:w,height:h,channels}}).png().toFile(dest+'/'+name+'.png');
 for(const key of ['base','hair','contact','foreground'])await png(result[key],key);await png(H,'ownership',1);await png(result.weight,'weight',1);await png(allowed,'contact-allowed',1);
 const U=new Uint8Array(n*4);for(let i=0;i<n;i++)if(result.weight[i]){U.set(u.data.subarray(i*4,i*4+4),i*4);U[i*4+3]=255;}await png(U,'underpaint');
 let minX=w,minY=h,maxX=0,maxY=0;for(let i=0;i<n;i++)if(result.weight[i]){const x=i%w,y=Math.floor(i/w);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
 const bounds=[minX-2,minY-2,maxX-minX+5,maxY-minY+5],xs=Array.from({length:17},(_,i)=>bounds[0]+bounds[2]*i/16);
 const rootLine=xs.map(x=>{let first=h;for(let xx=Math.max(0,Math.round(x)-18);xx<=Math.min(w-1,Math.round(x)+18);xx++)for(let y=minY;y<=maxY;y++)if(H[y*w+xx]){first=Math.min(first,y);break;}return[x,first===h?maxY-12:Math.min(maxY-12,first+8)];});
 // Pin real fringe pixels near the soft exterior matte instead of deleting hair.
 const nearEdge=Uint8Array.from(H,(v,i)=>v&&distance[i]<81?1:0),edgeGuards=[];
 for(let seed=0;seed<n;seed++)if(nearEdge[seed]){let minx=w,miny=h,maxx=0,maxy=0;head=0;tail=0;queue[tail++]=seed;nearEdge[seed]=0;
  while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);minx=Math.min(minx,x);miny=Math.min(miny,y);maxx=Math.max(maxx,x);maxy=Math.max(maxy,y);
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy,j=yy*w+xx;if(xx>=0&&xx<w&&yy>=0&&yy<h&&nearEdge[j]){nearEdge[j]=0;queue[tail++]=j;}}}
  edgeGuards.push({rect:[minx,miny,maxx-minx+1,maxy-miny+1],padding:8});}
 const spec={schemaVersion:1,kind:'short-hair-mesh-binding',poseId:id,sourceSha256:sha(await fs.readFile(sr)),bounds,grid:{columns:25,rows:29},rootLine,tipLine:[[bounds[0],bounds[1]+bounds[3]],[bounds[0]+bounds[2],bounds[1]+bounds[3]]],travel:{x:6,y:1},revealMarginPx:12,runtimeValidated:true,protectedRegions:[...config.poses[id].meshProtection.map(polygon=>({polygon,padding:8})),...edgeGuards]};
 const trial=createHairMeshBinding(spec);
 // Retain the prior runtime gate ONLY for exact registered geometry. A changed
 // build stays a candidate until its own browser/pixel review is completed.
 if(JSON.stringify(serializeHairMeshBinding(trial))!==JSON.stringify(registered[id].binding))spec.runtimeValidated=false;
 const binding=createHairMeshBinding(spec),serialized=serializeHairMeshBinding(binding);await fs.writeFile(dest+'/binding.json',JSON.stringify(serialized,null,2)+'\n');
 const report={...result.statistics,clippedToOpaqueMatte:clipped,outerHairPins:edgeGuards,bounds,binding:{vertices:binding.positions.length/2,triangles:binding.triangles.length/3,minimumAreaRatio:binding.minimumAreaRatio,maxWeight:Math.max(...binding.weights)}};await fs.writeFile(dest+'/report.json',JSON.stringify(report,null,2)+'\n');
 const entry={generatedUnderpaint:registered[id].generatedUnderpaint,source:{path:record.source,sha256:record.sourceSha256},alphaSha256:record.matteSha256,binding:serialized,supportRadius:24,solidRadius:12};
 for(const key of ['ownership','weight','underpaint','hairOwnership']){const file=out+'/'+id+'-'+key+'.png';await fs.copyFile(key==='hairOwnership'?hp:dest+'/'+key+'.png',file);const bytes=await fs.readFile(file);entry[key]={path:'./assets/short-hair-fringe-v1/'+path.basename(file),bytes:bytes.length,sha256:sha(bytes)};}
 manifest.poses[id]=entry;await fs.writeFile(out+'/manifest.json',JSON.stringify(manifest,null,2)+'\n');console.log(id,JSON.stringify(report));
}
