/** Registered 2D foreground-hair meshes. This module owns geometry only:
 * it cannot approve artwork, invent hidden pixels, or move the face canvas.
 * A validated hidden-surface band is a prerequisite for any displacement. */
export const HAIR_MESH_POSES=Object.freeze(['front','view-left','view-right','view-left-up','view-right-up','view-left-down','view-up','view-down','view-right-down']);
export const HAIR_MESH_SIZE=Object.freeze([1122,1402]);
const EPS=1e-8,MIN_AREA_RATIO=.25,MAX_VERTICES=16000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const point=value=>Array.isArray(value)&&value.length===2&&value.every(finite);
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const smooth=n=>n*n*(3-2*n);
const ownKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const compiled=new WeakSet();
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const boundsContains=(b,p)=>p[0]>=b[0]&&p[0]<=b[0]+b[2]&&p[1]>=b[1]&&p[1]<=b[1]+b[3];
function lineY(line,x){
  if(x<=line[0][0])return line[0][1];if(x>=line.at(-1)[0])return line.at(-1)[1];
  const right=line.findIndex(p=>p[0]>=x),a=line[right-1],b=line[right];
  return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);
}
function distanceToSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
  const t=length?clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
function onSegment(p,a,b){return Math.abs(cross(a,b,p))<=EPS&&p[0]>=Math.min(a[0],b[0])-EPS&&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;}
function segmentsIntersect(a,b,c,d){const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  return abC*abD<0&&cdA*cdB<0||onSegment(c,a,b)||onSegment(d,a,b)||onSegment(a,c,d)||onSegment(b,c,d);
}
function segmentDistance(a,b,c,d){return segmentsIntersect(a,b,c,d)?0:Math.min(distanceToSegment(a,c,d),distanceToSegment(b,c,d),distanceToSegment(c,a,b),distanceToSegment(d,a,b));}
function insidePolygon(p,polygon){let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i];if(onSegment(p,a,b))return true;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }return inside;
}
function polygonDistance(p,polygon){if(insidePolygon(p,polygon))return 0;
  return Math.min(...polygon.map((a,i)=>distanceToSegment(p,a,polygon[(i+1)%polygon.length])));
}
function triangleTouchesRegion(triangle,polygon,guard){
  if(triangle.some(p=>insidePolygon(p,polygon))||polygon.some(p=>insidePolygon(p,triangle)))return true;
  for(let i=0;i<3;i++)for(let j=0;j<polygon.length;j++)
    if(segmentDistance(triangle[i],triangle[(i+1)%3],polygon[j],polygon[(j+1)%polygon.length])<=guard+EPS)return true;
  return false;
}
function triangleTouchesLine(triangle,line){
  for(let i=0;i<line.length-1;i++){
    if(insidePolygon(line[i],triangle)||insidePolygon(line[i+1],triangle))return true;
    for(let j=0;j<3;j++)if(segmentsIntersect(triangle[j],triangle[(j+1)%3],line[i],line[i+1]))return true;
  }return false;
}

function validatePolygon(polygon){
  if(!Array.isArray(polygon)||polygon.length<3||polygon.length>64||polygon.some(p=>!point(p)||!boundsContains([0,0,...HAIR_MESH_SIZE],p)))throw new TypeError('保护区域需要原稿范围内的有限多边形。');
  if(polygon.some((p,i)=>Math.hypot(p[0]-polygon[(i+1)%polygon.length][0],p[1]-polygon[(i+1)%polygon.length][1])<EPS))throw new TypeError('保护区域包含重复相邻顶点。');
  for(let i=0;i<polygon.length;i++)for(let j=i+1;j<polygon.length;j++){
    if(j===i+1||i===0&&j===polygon.length-1)continue;
    if(segmentsIntersect(polygon[i],polygon[(i+1)%polygon.length],polygon[j],polygon[(j+1)%polygon.length]))throw new TypeError('保护区域不能自相交。');
  }
  const area=polygon.reduce((sum,p,i)=>sum+p[0]*polygon[(i+1)%polygon.length][1]-p[1]*polygon[(i+1)%polygon.length][0],0);
  if(Math.abs(area)<1)throw new TypeError('保护区域面积过小。');
  return polygon.map(p=>[...p]);
}
function normalizedRegion(raw){
  if(!object(raw)||!finite(raw.padding)||raw.padding<0||raw.padding>80||Object.keys(raw).some(k=>!['rect','polygon','padding'].includes(k))||Boolean(raw.rect)===Boolean(raw.polygon))throw new TypeError('保护区域需要 rect 或 polygon 及 0–80 像素 padding。');
  let polygon=raw.polygon;
  if(raw.rect){const r=raw.rect;if(!Array.isArray(r)||r.length!==4||!r.every(finite)||r[2]<=0||r[3]<=0)throw new TypeError('保护矩形无效。');
    polygon=[[r[0],r[1]],[r[0]+r[2],r[1]],[r[0]+r[2],r[1]+r[3]],[r[0],r[1]+r[3]]];}
  return {polygon:validatePolygon(polygon),padding:raw.padding};
}
function normalizeBinding(raw){
  const allowed=['schemaVersion','kind','poseId','sourceSha256','bounds','grid','rootLine','tipLine','travel','revealMarginPx','runtimeValidated','protectedRegions'];
  if(!object(raw)||!ownKeys(raw,allowed)||raw.schemaVersion!==1||raw.kind!=='short-hair-mesh-binding'
    ||!HAIR_MESH_POSES.includes(raw.poseId)||!hash(raw.sourceSha256)||typeof raw.runtimeValidated!=='boolean'
    ||!Array.isArray(raw.bounds)||raw.bounds.length!==4||!raw.bounds.every(finite)||raw.bounds[2]<8||raw.bounds[3]<8
    ||!boundsContains([0,0,...HAIR_MESH_SIZE],raw.bounds.slice(0,2))||!boundsContains([0,0,...HAIR_MESH_SIZE],[raw.bounds[0]+raw.bounds[2],raw.bounds[1]+raw.bounds[3]])
    ||!ownKeys(raw.grid,['columns','rows'])||!Number.isSafeInteger(raw.grid.columns)||!Number.isSafeInteger(raw.grid.rows)||raw.grid.columns<2||raw.grid.columns>64||raw.grid.rows<2||raw.grid.rows>64
    ||!ownKeys(raw.travel,['x','y'])||![raw.travel.x,raw.travel.y].every(n=>finite(n)&&n>=0&&n<=12)
    ||!finite(raw.revealMarginPx)||raw.revealMarginPx<0||raw.revealMarginPx>24
    ||!Array.isArray(raw.protectedRegions)||raw.protectedRegions.length>16)throw new TypeError('前发网格登记无效。');
  for(const line of [raw.rootLine,raw.tipLine]){
    if(!Array.isArray(line)||line.length<2||line.length>32||line.some((p,i)=>!point(p)||!boundsContains(raw.bounds,p)||i>0&&p[0]<=line[i-1][0])
      ||line[0][0]!==raw.bounds[0]||line.at(-1)[0]!==raw.bounds[0]+raw.bounds[2])throw new TypeError('发根与发梢线必须按 x 递增并覆盖网格宽度。');
  }
  const stops=[...new Set([...raw.rootLine,...raw.tipLine].map(p=>p[0]))];
  if(stops.some(x=>lineY(raw.tipLine,x)-lineY(raw.rootLine,x)<8))throw new TypeError('发根与发梢线必须保持至少 8 像素间距。');
  const maxTravel=Math.hypot(raw.travel.x,raw.travel.y);
  // Two source pixels cover filtering at the newly exposed edge.
  if(raw.runtimeValidated&&raw.revealMarginPx+EPS<maxTravel+2)throw new TypeError('已验证补画带不足以覆盖网格最大位移和采样边缘。');
  return {...raw,bounds:[...raw.bounds],grid:{...raw.grid},rootLine:raw.rootLine.map(p=>[...p]),tipLine:raw.tipLine.map(p=>[...p]),travel:{...raw.travel},protectedRegions:raw.protectedRegions.map(normalizedRegion)};
}
function freezeDeep(value){if(value&&typeof value==='object'){Object.values(value).forEach(freezeDeep);Object.freeze(value);}return value;}
function areaRatios(positions,rest,triangles){let min=Infinity;
  for(let i=0;i<triangles.length;i+=3){const a=triangles[i]*2,b=triangles[i+1]*2,c=triangles[i+2]*2;
    const area=(positions[b]-positions[a])*(positions[c+1]-positions[a+1])-(positions[b+1]-positions[a+1])*(positions[c]-positions[a]);
    const original=(rest[b]-rest[a])*(rest[c+1]-rest[a+1])-(rest[b+1]-rest[a+1])*(rest[c]-rest[a]);
    min=Math.min(min,area/original);}return min;
}
function shifted(binding,x,y){return binding.positions.map((value,i)=>value+binding.weights[i>>1]*(i%2?binding.travel.y*y:binding.travel.x*x));}

/** Lower-envelope propagation limits each horizontal/vertical weight slope.
 * For this rectangular triangulation det(I+v grad(w)) = 1+v·grad(w).
 * Bounding each slope by .5/(travel.x+travel.y) guarantees det >= .5 for
 * the full control square, even beside a tiny protected triangle. Only lowers
 * weights, so root/feature pins and the hidden-surface displacement bound hold. */
function limitWeightSlopes(weights,xStops,yStops,travel){
  const amount=travel.x+travel.y;if(amount===0)return 0;
  const slope=.5/amount,width=xStops.length,initial=[...weights],heap=[];
  const push=item=>{let i=heap.length;heap.push(item);while(i>0){const p=(i-1)>>1;if(heap[p][0]<=item[0])break;heap[i]=heap[p];i=p;}heap[i]=item;};
  const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1][0]<heap[c][0])c++;if(heap[c][0]>=last[0])break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
  weights.forEach((value,id)=>push([value,id]));
  while(heap.length){const [value,id]=pop();if(value>weights[id]+EPS)continue;const x=id%width,y=Math.floor(id/width),neighbors=[];
    if(x>0)neighbors.push([id-1,xStops[x]-xStops[x-1]]);if(x+1<width)neighbors.push([id+1,xStops[x+1]-xStops[x]]);
    if(y>0)neighbors.push([id-width,yStops[y]-yStops[y-1]]);if(y+1<yStops.length)neighbors.push([id+width,yStops[y+1]-yStops[y]]);
    for(const [to,distance]of neighbors){const candidate=value+distance*slope;if(candidate<weights[to]-EPS){weights[to]=candidate;push([candidate,to]);}}
  }
  return weights.filter((value,i)=>value<initial[i]-EPS).length;
}

/** Accepts a complete serialized binding, adds a deterministic triangle mesh,
 * and proves the entire bounded control square cannot fold its triangles.
 * Protection pins every triangle intersecting a feature polygon expanded by
 * maximum travel+two sampling pixels, including thin polygons between vertices.
 * runtimeValidated is a technical acceptance flag, never artwork approval. */
export function createHairMeshBinding(raw){
  const spec=normalizeBinding(raw),[bx,by,bw,bh]=spec.bounds;
  const xs=Array.from({length:spec.grid.columns},(_,i)=>bx+bw*i/(spec.grid.columns-1));
  const ys=Array.from({length:spec.grid.rows},(_,i)=>by+bh*i/(spec.grid.rows-1));
  for(const p of [...spec.rootLine,...spec.tipLine]){xs.push(p[0]);ys.push(p[1]);}
  const guard=Math.hypot(spec.travel.x,spec.travel.y)+2;
  // Keep narrow gaps between features represented even on a modest base grid.
  for(const region of spec.protectedRegions){
    const x=region.polygon.map(p=>p[0]),y=region.polygon.map(p=>p[1]);
    for(const value of [Math.min(...x),Math.max(...x)])for(const offset of [0,-guard,guard,-guard-region.padding,guard+region.padding])xs.push(clamp(value+offset,bx,bx+bw));
    for(const value of [Math.min(...y),Math.max(...y)])for(const offset of [0,-guard,guard,-guard-region.padding,guard+region.padding])ys.push(clamp(value+offset,by,by+bh));
  }
  const unique=values=>values.sort((a,b)=>a-b).filter((v,i,a)=>i===0||v-a[i-1]>EPS),xStops=unique(xs),yStops=unique(ys);
  if(xStops.length*yStops.length>MAX_VERTICES)throw new TypeError('网格顶点数量超出限制。');
  const positions=[],weights=[],triangles=[],pinned=new Set();
  for(const y of yStops)for(const x of xStops){positions.push(x,y);const root=lineY(spec.rootLine,x),tip=lineY(spec.tipLine,x);
    let weight=smooth(clamp((y-root)/(tip-root)));
    for(const region of spec.protectedRegions){const distance=polygonDistance([x,y],region.polygon);
      const pin=distance<=guard?0:region.padding===0?1:smooth(clamp((distance-guard)/region.padding));weight*=pin;}
    weights.push(weight);
  }
  const width=xStops.length;
  for(let y=0;y<yStops.length-1;y++)for(let x=0;x<width-1;x++){
    const a=y*width+x,b=a+1,c=a+width,d=c+1;triangles.push(a,b,c,b,d,c);
  }
  for(let i=0;i<triangles.length;i+=3){const ids=triangles.slice(i,i+3),triangle=ids.map(id=>[positions[id*2],positions[id*2+1]]);
    if(triangleTouchesLine(triangle,spec.rootLine)||spec.protectedRegions.some(region=>triangleTouchesRegion(triangle,region.polygon,guard)))ids.forEach(id=>pinned.add(id));
  }
  for(const id of pinned)weights[id]=0;
  const slopeLimitedVertexCount=limitWeightSlopes(weights,xStops,yStops,spec.travel);
  const binding={...spec,positions,weights,triangles,xStops,yStops,protectedTriangleVertexCount:pinned.size,slopeLimitedVertexCount};
  let minAreaRatio=1;
  for(const x of [-1,1])for(const y of [-1,1])minAreaRatio=Math.min(minAreaRatio,areaRatios(shifted(binding,x,y),positions,triangles));
  if(!finite(minAreaRatio)||minAreaRatio<MIN_AREA_RATIO)throw new TypeError('登记位移会压扁或翻转网格，请减小行程或增加过渡区。');
  binding.minimumAreaRatio=minAreaRatio;freezeDeep(binding);compiled.add(binding);return binding;
}

export function validateHairMeshBinding(raw){return createHairMeshBinding(raw);}
export function serializeHairMeshBinding(binding){
  if(!compiled.has(binding))throw new TypeError('需要已编译的前发网格。');
  const {schemaVersion,kind,poseId,sourceSha256,bounds,grid,rootLine,tipLine,travel,revealMarginPx,runtimeValidated,protectedRegions}=binding;
  return {schemaVersion,kind,poseId,sourceSha256,bounds:[...bounds],grid:{...grid},rootLine:rootLine.map(p=>[...p]),tipLine:tipLine.map(p=>[...p]),travel:{...travel},revealMarginPx,runtimeValidated,
    protectedRegions:protectedRegions.map(r=>({polygon:r.polygon.map(p=>[...p]),padding:r.padding}))};
}

/** A null/untested binding is a rest pose. Invalid data is rejected rather than
 * coerced; callers may retain their last committed canvas after an error. */
export function deformHairMesh(binding,controls={x:0,y:0},{enabled=true,original=false}={}){
  if(!ownKeys(controls,['x','y'])||![controls.x,controls.y].every(n=>finite(n)&&Math.abs(n)<=1)||typeof enabled!=='boolean'||typeof original!=='boolean')throw new TypeError('前发网格输入需要 -1–1 的 x、y。');
  if(binding===null||binding===undefined)return {binding:null,positions:null,moved:false,maxDisplacementPx:0,minimumAreaRatio:1};
  if(!compiled.has(binding))throw new TypeError('前发网格必须先完成登记校验。');
  if(!enabled||original||!binding.runtimeValidated||(controls.x===0&&controls.y===0))return {binding,positions:binding.positions,moved:false,maxDisplacementPx:0,minimumAreaRatio:1};
  const positions=shifted(binding,controls.x,controls.y),maxDisplacementPx=Math.hypot(binding.travel.x*controls.x,binding.travel.y*controls.y)*Math.max(...binding.weights);
  const minimumAreaRatio=areaRatios(positions,binding.positions,binding.triangles);
  if(minimumAreaRatio<MIN_AREA_RATIO-EPS)throw new Error('前发网格形变超出登记安全范围。');
  return {binding,positions,moved:maxDisplacementPx>0,maxDisplacementPx,minimumAreaRatio};
}

/** Exact piecewise-affine sampling, used for diagnostics and feature guards. */
export function sampleHairMeshDisplacement(binding,frame,x,y){
  if(!compiled.has(binding)||frame?.binding!==binding||!Array.isArray(frame.positions)||frame.positions.length!==binding.positions.length||!finite(x)||!finite(y))throw new TypeError('网格采样输入无效。');
  if(!boundsContains(binding.bounds,[x,y]))return {x:0,y:0};
  const locate=(stops,value)=>Math.max(0,Math.min(stops.length-2,stops.findIndex(n=>n>=value)-1));
  const col=locate(binding.xStops,x),row=locate(binding.yStops,y),w=binding.xStops.length;
  const a=row*w+col,b=a+1,c=a+w,d=c+1;
  const tx=(x-binding.xStops[col])/(binding.xStops[col+1]-binding.xStops[col]),ty=(y-binding.yStops[row])/(binding.yStops[row+1]-binding.yStops[row]);
  const ids=tx+ty<=1?[a,b,c]:[b,d,c],mix=tx+ty<=1?[1-tx-ty,tx,ty]:[1-ty,tx+ty-1,1-tx];
  return {x:ids.reduce((sum,id,i)=>sum+(frame.positions[id*2]-binding.positions[id*2])*mix[i],0),y:ids.reduce((sum,id,i)=>sum+(frame.positions[id*2+1]-binding.positions[id*2+1])*mix[i],0)};
}
