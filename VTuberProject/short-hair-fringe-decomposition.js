/** Offline, pixel-preserving decomposition of registered foreground hair and
 * its contact shadow. No model inference, file I/O, image resampling or clocks.
 * Callers must visually validate the semantic ownership and hidden painting.
 * This module proves only support, RGBA arithmetic and coordinate invariants. */
const byteArray=value=>value instanceof Uint8Array||value instanceof Uint8ClampedArray;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const smooth=value=>value*value*(3-2*value);
function dimensions(width,height){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>4096||height>4096||width*height>4194304)throw new TypeError('分层需要有效且有限的原生像素尺寸。');
 return width*height;
}
function bytes(value,length,label){if(!byteArray(value)||value.length!==length)throw new TypeError(`${label}需要相同尺寸的字节数组。`);return value;}
function binary(value,length,label){bytes(value,length,label);if(value.some(v=>v!==0&&v!==255))throw new TypeError(`${label}必须为 0/255 二值像素归属。`);return value;}
function scalarOptions(supportRadius,solidRadius){
 if(!finite(supportRadius)||supportRadius<=0||supportRadius>32||!finite(solidRadius)||solidRadius<0||solidRadius>=supportRadius)throw new TypeError('前发支持环需要 0≤实心范围<外半径≤32 像素。');
}

// Exact squared Euclidean distance transform. Infinite scan lines are handled
// explicitly; no diagonal chamfer approximation or repeated mask growth.
function distanceLine(input,length,output,vertices,breaks){
 let first=0;while(first<length&&!Number.isFinite(input[first]))first++;
 if(first===length){output.fill(Infinity,0,length);return;}
 let k=0;vertices[0]=first;breaks[0]=-Infinity;breaks[1]=Infinity;
 for(let q=first+1;q<length;q++){
  if(!Number.isFinite(input[q]))continue;
  let v=vertices[k],s=((input[q]+q*q)-(input[v]+v*v))/(2*(q-v));
  while(k>0&&s<=breaks[k]){k--;v=vertices[k];s=((input[q]+q*q)-(input[v]+v*v))/(2*(q-v));}
  k++;vertices[k]=q;breaks[k]=s;breaks[k+1]=Infinity;
 }
 k=0;for(let q=0;q<length;q++){while(breaks[k+1]<q)k++;const delta=q-vertices[k];output[q]=delta*delta+input[vertices[k]];}
}
export function squaredDistanceToOwnership(ownership,width,height){
 const count=dimensions(width,height);binary(ownership,count,'前发归属');if(!ownership.some(v=>v===255))throw new TypeError('前发归属不能为空。');
 const horizontal=new Float64Array(count),result=new Float64Array(count),longest=Math.max(width,height);
 const input=new Float64Array(longest),output=new Float64Array(longest),vertices=new Int32Array(longest),breaks=new Float64Array(longest+1);
 for(let y=0;y<height;y++){for(let x=0;x<width;x++)input[x]=ownership[y*width+x]===255?0:Infinity;distanceLine(input,width,output,vertices,breaks);horizontal.set(output.subarray(0,width),y*width);}
 for(let x=0;x<width;x++){for(let y=0;y<height;y++)input[y]=horizontal[y*width+x];distanceLine(input,height,output,vertices,breaks);for(let y=0;y<height;y++)result[y*width+x]=output[y];}
 return result;
}

/** Contact guards apply only outside actual hair ownership. Hair over a
 * feature stays in its original layer and must be pinned by the mesh; erasing
 * it from ownership would create a semantic hole rather than protect a face.
 * Only fully opaque original-character pixels can enter the contact ring. */
export function createFringeSupport({width,height,ownership,contactAllowed,characterAlpha,supportRadius=12,solidRadius=3}={}){
 const count=dimensions(width,height);scalarOptions(supportRadius,solidRadius);
 binary(ownership,count,'前发归属');binary(contactAllowed,count,'可处理接触区域');bytes(characterAlpha,count,'原始角色透明度');
 const distanceSquared=squaredDistanceToOwnership(ownership,width,height),support=new Uint8Array(count),weight=new Uint8Array(count),weights=new Float32Array(count);
 let ownedPixels=0,contactPixels=0,guardedRingPixels=0,outerAlphaExcludedPixels=0;
 for(let i=0;i<count;i++){
  if(ownership[i]===255){if(characterAlpha[i]!==255)throw new TypeError('可动前发必须完全位于原角色不透明内侧。');support[i]=255;weight[i]=255;weights[i]=1;ownedPixels++;continue;}
  const distance=Math.sqrt(distanceSquared[i]);if(distance>=supportRadius)continue;
  if(contactAllowed[i]!==255){guardedRingPixels++;continue;}
  if(characterAlpha[i]!==255){outerAlphaExcludedPixels++;continue;}
  const smoothWeight=distance<=solidRadius?1:1-smooth((distance-solidRadius)/(supportRadius-solidRadius));
  const quantizedWeight=Math.round(smoothWeight*255);
  if(quantizedWeight===0)continue;support[i]=255;weight[i]=quantizedWeight;weights[i]=quantizedWeight/255;contactPixels++;
 }
 return {support,weight,weights,distanceSquared,statistics:{ownedPixels,contactPixels,guardedRingPixels,outerAlphaExcludedPixels,supportRadius,solidRadius,weightEncoding:'uint8-unorm; use weight/255 as the single authoritative mix coefficient'}};
}

/** Minimal valid foreground alpha for opaque S=(1-a)*U+a*P. Rounding alpha
 * UP before solving RGB keeps all P channels in gamut. Alpha-zero pixels use
 * RGB zero, which also makes later premultiplied filtering well-defined. */
export function decomposeOpaqueColor(source,base){
 if(!Array.isArray(source)||!Array.isArray(base)||source.length!==3||base.length!==3||[...source,...base].some(v=>!Number.isInteger(v)||v<0||v>255))throw new TypeError('颜色分解需要两组三通道 8 位 RGB。');
 let required=0;
 for(let c=0;c<3;c++){const s=source[c],u=base[c];if(s<u)required=Math.max(required,(u-s)/u);else if(s>u)required=Math.max(required,(s-u)/(255-u));}
 if(required===0)return [0,0,0,0];
 const alpha=Math.min(255,Math.ceil(required*255)),a=alpha/255;
 const rgb=source.map((s,c)=>Math.max(0,Math.min(255,Math.round((s-(1-a)*base[c])/a))));
 return [...rgb,alpha];
}

/** Returns full native RGBA arrays; no source input is mutated.
 * base: source outside support, hidden paint inside H, smooth hidden/source mix
 *       in the allowed contact ring.
 * hair: original RGB at binary ownership H, fully opaque there.
 * contact: algebraic residual ONLY in C\\H, preserving the old contact shade.
 * foreground: disjoint union of hair/contact for one shared mesh deformation.
 * The mathematical zero-pose reconstruction is measured per output pixel;
 * GPU/PNG premultiplication may still round a channel by one, so the live
 * renderer must retain its exact identity path when deformation is zero. */
export function decomposeFringeLayers({width,height,source,underpaint,ownership,contactAllowed,characterAlpha,supportRadius=12,solidRadius=3}={}){
 const count=dimensions(width,height);bytes(source,count*4,'原稿 RGBA');bytes(underpaint,count*4,'隐藏补画 RGBA');
 const prepared=createFringeSupport({width,height,ownership,contactAllowed,characterAlpha,supportRadius,solidRadius});
 const base=new Uint8ClampedArray(source),hair=new Uint8ClampedArray(count*4),contact=new Uint8ClampedArray(count*4),foreground=new Uint8ClampedArray(count*4);
 let contactVisiblePixels=0,contactAlphaSum=0,maxFloatReconstructionError=0,roundedReconstructionMismatchPixels=0;
 for(let i=0;i<count;i++){
  if(prepared.support[i]!==255)continue;const k=i*4;
  if(source[k+3]!==255||underpaint[k+3]!==255)throw new TypeError('支持环内的原稿与隐藏补画必须不透明；不能把未知 alpha 当作完整补画。');
  // Read back the exact exported 8-bit W, not the Float32 convenience view:
  // authoring and GPU upload must use the same quantized mixing coefficient.
  const w=prepared.weight[i]/255;for(let c=0;c<3;c++)base[k+c]=Math.round(source[k+c]+(underpaint[k+c]-source[k+c])*w);
  if(ownership[i]===255){hair.set(source.subarray(k,k+4),k);foreground.set(source.subarray(k,k+4),k);continue;}
  const pixel=decomposeOpaqueColor(Array.from(source.subarray(k,k+3)),Array.from(base.subarray(k,k+3)));
  contact.set(pixel,k);foreground.set(pixel,k);if(pixel[3])contactVisiblePixels++;contactAlphaSum+=pixel[3];
  let mismatch=false;const a=pixel[3]/255;
  for(let c=0;c<3;c++){const result=(1-a)*base[k+c]+a*pixel[c];maxFloatReconstructionError=Math.max(maxFloatReconstructionError,Math.abs(result-source[k+c]));mismatch||=Math.round(result)!==source[k+c];}
  if(mismatch)roundedReconstructionMismatchPixels++;
 }
 return {width,height,base,hair,contact,foreground,support:prepared.support,weight:prepared.weight,weights:prepared.weights,
  statistics:{...prepared.statistics,contactVisiblePixels,meanContactAlpha:contactVisiblePixels?contactAlphaSum/contactVisiblePixels:0,maxFloatReconstructionError,roundedReconstructionMismatchPixels,
   semantics:'contact residual carries original edge/shadow appearance; it is not newly generated anatomy or an independent face feature'}};
}
