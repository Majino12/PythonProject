import {decomposeOpaqueColor} from './short-hair-fringe-decomposition.js';

export const FRINGE_LAYER_README=`透明前发分层导出（派生候选）
原位重组顺序（从下到上）：torso.png → face.png → backHair.png → frontHair.png → contact.png → edgeCorrection.png。所有图层使用原生尺寸、同一原点、正常 source-over、100% 不透明度。
face 是登记补画支持的脸部表面，保护区可能保留原发丝，不是完整无发裸脸；backHair 是固定的其余可见头发，未补全被遮挡的后发。生成补画和模型分层均未升级人工绘稿批准。
contact 保留 W=255 的原有接触残差；edgeCorrection 保留 0<W<255 的混合边缘残差，原位重组必须包含二者。
ownership/weight/hairOwnership.png 是不透明灰度数据图，不要作为画稿叠加；underpaint.png 是仅支持区内有像素的生成补画候选，也不要直接叠加。binding.json 保留原生坐标网格登记；layers.json 记录语义、来源、重组顺序和像素核验。
character/head/recomposed.png 为替代参考图，不要再次叠加进上述组合。眼、口、眉 PNG 是含皮肤和遮挡的局部替换片，不是附加纯五官层。
导出当前实际方向端点与表情/视线；动态网格和模型中间转角未烘焙。不同软件的 PNG 预乘取整可能有 1 级通道差异。
`;

const byteArray=value=>value instanceof Uint8Array||value instanceof Uint8ClampedArray;
function bytes(value,length,label){if(!byteArray(value)||value.length!==length)throw new TypeError(`${label}字节数无效。`);return value;}
function binary(value,length,label){bytes(value,length,label);if(value.some(v=>v!==0&&v!==255))throw new TypeError(`${label}必须为二值归属。`);return value;}

/** Button-time decomposition from the REGISTERED W bytes. It does not infer a
 * new support ring, repaint RGB, or run in the animation loop. source already
 * carries the original character alpha, applied once after expression/gaze. */
export function decomposeRegisteredFringeLayers({width,height,source,underpaint,ownership,weight,hairOwnership,headOwnership}={}){
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>4194304)throw new TypeError('分层导出尺寸无效。');
 const count=width*height;bytes(source,count*4,'角色');bytes(underpaint,count*4,'隐藏补画');
 binary(ownership,count,'前发');bytes(weight,count,'混合权重');binary(hairOwnership,count,'全部头发');binary(headOwnership,count,'头部');
 const face=new Uint8ClampedArray(count*4),backHair=new Uint8ClampedArray(count*4),frontHair=new Uint8ClampedArray(count*4);
 const contact=new Uint8ClampedArray(count*4),edgeCorrection=new Uint8ClampedArray(count*4),recomposed=new Uint8ClampedArray(source);
 const statistics={frontHairPixels:0,backHairPixels:0,contactPixels:0,edgeCorrectionPixels:0,reconstructionMismatchPixels:0,maxReconstructionChannelError:0,weightEncoding:'registered uint8 UNORM; W/255'};
 for(let i=0;i<count;i++){
  const k=i*4,h=ownership[i]===255,w=weight[i],head=headOwnership[i]===255;
  if(h&&(w!==255||hairOwnership[i]!==255||!head))throw new TypeError('前发归属、权重、头发或头部登记不一致。');
  if(w>0&&(source[k+3]!==255||underpaint[k+3]!==255||!head))throw new TypeError('混合支持区必须位于完整不透明的头部和补画内。');
  if(w===0&&underpaint[k+3]!==0)throw new TypeError('隐藏补画越出登记的混合支持区。');
  const base=[source[k],source[k+1],source[k+2],source[k+3]];
  if(w>0)for(let c=0;c<3;c++)base[c]=Math.round(source[k+c]+(underpaint[k+c]-source[k+c])*w/255);
  // The fixed remaining hair is a visible partition, not an invented complete
  // back-of-head painting. The front-owned region belongs to generated face.
  if(head){const remainingHair=hairOwnership[i]===255&&!h;(remainingHair?backHair:face).set(base,k);if(remainingHair&&base[3])statistics.backHairPixels++;}
  let residual=null;
  if(h){frontHair.set(source.subarray(k,k+4),k);residual=Array.from(source.subarray(k,k+4));statistics.frontHairPixels++;}
  else if(w>0){residual=decomposeOpaqueColor(Array.from(source.subarray(k,k+3)),base.slice(0,3));
   const target=w===255?contact:edgeCorrection;target.set(residual,k);if(residual[3])statistics[w===255?'contactPixels':'edgeCorrectionPixels']++;
  }
  if(residual){const a=residual[3]/255;let mismatch=false;
   for(let c=0;c<3;c++){recomposed[k+c]=Math.round(base[c]*(1-a)+residual[c]*a);const error=Math.abs(recomposed[k+c]-source[k+c]);statistics.maxReconstructionChannelError=Math.max(statistics.maxReconstructionChannelError,error);mismatch||=error!==0;}
   if(mismatch)statistics.reconstructionMismatchPixels++;
  }
 }
 return {width,height,layers:{face,backHair,frontHair,contact,edgeCorrection,recomposed},statistics};
}

const nativeSize=[1122,1402];
function canvasFromBytes(data,width=1122,height=1402){const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d'),image=ctx.createImageData(width,height);image.data.set(data);ctx.putImageData(image,0,0);return c;}
function pixels(image){const c=document.createElement('canvas');[c.width,c.height]=nativeSize;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);return ctx.getImageData(0,0,...nativeSize).data;}
function scalarFromRGBA(data){const result=new Uint8Array(1122*1402);for(let i=0;i<result.length;i++)result[i]=data[i*4];return result;}

export function describeRegisteredFringeLayers(manifest,poseId,statistics){
 const pose=manifest.poses[poseId],candidate={status:'derived-candidate',manuallyApproved:false,artworkApprovalChanged:false};
 const descriptors={
  face:{label:'脸部表面（补画候选）',kind:'generated-supported-head-surface',...candidate,description:'包含登记补画与原有脸、耳、颈可见部分；保护区可能保留原发丝，不是完整无发裸脸。',completeBareFace:false,hiddenPixelsReconstructed:'registered underpaint support only'},
  frontHair:{label:'前发（原画像素）',kind:'original-rgb-fringe-partition',...candidate,description:'前发归属内的当前原画像素；零位重组时覆盖补画。',mask:'ownership.png'},
  backHair:{label:'其余头发（固定）',kind:'visible-remaining-hair-partition',...candidate,description:'头部范围内未划入前发的可见头发，含顶部、侧发和未拆前发；未补全被遮挡的后发。',hiddenPixelsReconstructed:false,completeBackHair:false},
  contact:{label:'接触修正层',kind:'original-contact-residual',...candidate,description:'前发外、W=255 区域的原有接触与颜色残差；配合脸部表面重组，不是独立五官。'},
  edgeCorrection:{label:'混合边缘修正层',kind:'original-blend-edge-residual',...candidate,description:'前发外、0<W<255 的混合边缘残差；必须参与原位重组。'},
  ownership:{label:'前发归属 H',kind:'binary-ownership-mask',...candidate,description:'不透明灰度数据图：255 为前发，0 为其他。',encoding:'opaque grayscale 0/255'},
  weight:{label:'补画混合权重 W',kind:'quantized-mix-weight',...candidate,description:'不透明灰度数据图：按 W/255 混合原画与补画，是唯一登记混合权重。',encoding:'opaque grayscale uint8 UNORM'},
  underpaint:{label:'隐藏补画 U（候选）',kind:'generated-hidden-paint',...candidate,description:'仅登记支持区内有像素；由生成模型补画，未经人工绘稿批准，不是完整脸部素材。'},
  hairOwnership:{label:'全部头发归属',kind:'binary-whole-hair-ownership',...candidate,description:'模型及有界修正得到的头发语义归属；不等于完整后发画稿。',encoding:'opaque grayscale 0/255'},
  recomposed:{label:'原位重组校验',kind:'zero-pose-reconstruction-check',description:'按登记透明层原位重组；模型中间转角及动态网格未烘焙到导出。'}
 };
 return {descriptors,descriptor:{schemaVersion:1,kind:'short-hair-fringe-layer-decomposition',...candidate,
  poseId,source:pose.source,alphaSha256:pose.alphaSha256,model:manifest.model,
  records:Object.fromEntries(['ownership','weight','underpaint','hairOwnership'].map(key=>[key,pose[key]])),
  bindingFile:'binding.json',coordinateSystem:'native source pixels; all PNGs use the original canvas and origin',
  stackBottomToTop:['torso.png','face.png','backHair.png','frontHair.png','contact.png','edgeCorrection.png'],
  maskFilesAreNotPaintLayers:['ownership.png','weight.png','hairOwnership.png'],
  alternateReferenceOnly:['character.png','head.png','recomposed.png','underpaint.png'],
  compositing:'Use ordinary source-over at 100% opacity and identical origin. Face/backHair/torso form the base. FrontHair/contact/edgeCorrection have disjoint support; do not additionally stack head, character, underpaint or feature replacement patches.',
  statistics,limitations:['face.png is a generated-supported surface candidate, not a complete bare face or manually approved anatomy.','backHair.png contains fixed visible remaining hair; occluded back hair and scalp are not reconstructed.','Contact and blend-edge correction retain original shade/color; they are required for reconstruction.','Integer RGBA arithmetic is checked; PNG/Canvas premultiplication may differ by one channel level in other software.','The authored pose endpoint and current expression/gaze are exported; dynamic mesh motion and neural in-between poses are not flattened.']}};
}

/** Uses only decoded, verified assets. Called by inspection/export buttons. */
export function createShortHairFringeLayerInspection(assets,poseId,character,head){
 const prepared=assets.fringe?.poses?.[poseId],manifest=assets.fringe?.manifest,pose=manifest?.poses?.[poseId];
 if(!prepared&&!pose)return null;
 if(!prepared||!pose||!prepared.binding?.runtimeValidated)throw new Error('当前方向的前发分层尚未通过登记校验。');
 if([character,head].some(c=>c.width!==1122||c.height!==1402))throw new Error('前发分层导出需要原生画稿尺寸。');
 const source=character.getContext('2d').getImageData(0,0,...nativeSize).data,headPixels=head.getContext('2d').getImageData(0,0,...nativeSize).data;
 const headOwnership=new Uint8Array(1122*1402);for(let i=0;i<headOwnership.length;i++)headOwnership[i]=headPixels[i*4+3]>0?255:0;
 const masks=prepared.maskPixels;if(!masks?.ownership||!masks?.weight||!masks?.hairOwnership)throw new Error('缺少原始前发遮罩字节。');
 const result=decomposeRegisteredFringeLayers({width:1122,height:1402,source,underpaint:pixels(prepared.underpaint),headOwnership,
  ownership:scalarFromRGBA(masks.ownership),weight:scalarFromRGBA(masks.weight),hairOwnership:scalarFromRGBA(masks.hairOwnership)});
 const layers=Object.fromEntries(Object.entries(result.layers).map(([key,data])=>[key,canvasFromBytes(data)]));
 for(const key of ['ownership','weight','hairOwnership'])layers[key]=canvasFromBytes(masks[key]);
 layers.underpaint=canvasFromBytes(pixels(prepared.underpaint));
 const described=describeRegisteredFringeLayers(manifest,poseId,result.statistics);
 return {layers,...described,binding:pose.binding};
}
