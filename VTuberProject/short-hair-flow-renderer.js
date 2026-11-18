import {FEATURE_GLSL,packFeatureGeometry,blendFeatureCharts,blendFeatureSets} from './short-hair-feature-geometry.js';
import {findMotionField} from './short-hair-motion-fields.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';

const VERTEX=`#version 300 es
in vec2 position;out vec2 uv;
void main(){uv=vec2(position.x,1.0-position.y);gl_Position=vec4(position*2.0-1.0,0.0,1.0);}`;
const FRAGMENT=`#version 300 es
precision highp float;precision highp sampler2D;precision highp sampler2DArray;
in vec2 uv;out vec4 color;
uniform sampler2DArray source0,source1,source2;
uniform vec4 sourceLayers[3];
uniform bool articulationEnabled,hairProtectionEnabled;
uniform sampler2D hair0,hair1,hair2;
uniform float progress[6];
uniform vec4 patchOwners[15];
uniform bool patchOwnersEnabled;
uniform sampler2DArray flow01,flow02,flow12,mask01,mask02,mask12;
${FEATURE_GLSL}
uniform vec3 weights,secondary;uniform bvec3 reversed;uniform bool singleSource;
// One small displacement is shared by RGB, alpha and the learned fields.
// This is exterior-tip deformation, not independent hair/face layering.
vec2 secondaryUV(vec2 p){
  float torso=smoothstep(.55,.88,p.y);
  float exterior=smoothstep(.23,.31,abs(p.x-.5));
  float tips=smoothstep(.18,.27,p.y)*(1.0-smoothstep(.47,.56,p.y))*exterior;
  return p-vec2(1.5*secondary.y+2.0*secondary.z*tips,2.0*secondary.x*torso)/vec2(1122.0,1402.0);
}
// The seven sampled times are true RIFE estimates. Interpolation between them
// is interpolation of motion/visibility, not a dissolve of unaligned paintings.
void field(sampler2DArray flow,sampler2DArray mask,vec2 p,float time,bool reverse,out vec4 d,out float m){
  float t=reverse?1.0-time:time;
  float z=clamp(t*8.0-1.0,0.0,6.0),a=floor(z),b=min(6.0,a+1.0);
  d=mix(texture(flow,vec3(p,a)),texture(flow,vec3(p,b)),z-a);
  m=mix(texture(mask,vec3(p,a)).r,texture(mask,vec3(p,b)).r,z-a);
  if(t<.125){d.xy*=t/.125;d.zw*=(1.0-t)/.875;m=mix(1.0,m,t/.125);}
  if(t>.875){d.xy*=t/.875;d.zw*=(1.0-t)/.125;m=mix(m,0.0,(t-.875)/.125);}
  if(reverse){d=d.zwxy;m=1.0-m;}
}
vec4 sampleSource(sampler2DArray source,vec2 p,float layer){
  vec4 sampleColor=texture(source,vec3(clamp(p,vec2(0.0),vec2(1.0)),layer));
  return vec4(sampleColor.rgb*sampleColor.a,sampleColor.a);
}
float ratio(float a,float b){return b/max(.000001,a+b);}
float expressionTime(vec2 pixel,float registeredTime,float registeredAmount,int slot,bool brow){
  float commonTime=-1.0;bool same=true;
  for(int f=1;f<6;f++)if((brow?f>=4:f<=3)&&progress[f]>0.0){if(commonTime<0.0)commonTime=progress[f];else if(abs(commonTime-progress[f])>.0000001)same=false;}
  // A single action (including bilateral blink) must recover its ENTIRE painted
  // endpoint, including the patch feather beyond the compact ink geometry.
  if(same)return max(0.0,commonTime);
  float best=1e20;int owner=3;
  for(int f=1;f<6;f++)if(brow?f>=4:f<=3){
    vec4 box=patchOwnersEnabled?patchOwners[slot*5+f-1]:featureTex(f,0,2);
    vec2 distance=max(max(box.xy-pixel,pixel-box.zw),vec2(0.0));
    float score=dot(distance,distance);
    if(score<best){best=score;owner=f;}
  }
  float time=progress[owner];
  if(!brow)time=mix(time,registeredTime,registeredAmount);
  return time;
}
vec4 sampleArticulated(sampler2DArray source,vec2 a,vec2 b,vec4 layers,int slot,float registeredTime,float registeredAmount){
  vec4 first=sampleSource(source,a,layers.x);
  if(!articulationEnabled)return first;
  vec2 pixel=(a+b)*.5*vec2(1122.0,1402.0);
  float faceTime=expressionTime(pixel,registeredTime,registeredAmount,slot,false);
  vec4 lower=mix(first,sampleSource(source,b,layers.y),faceTime);
  // C/A share UV a and D/B share UV b. Identical layers therefore make the
  // entire upper row redundant. A/B can share a layer but have different UVs,
  // so their two samples must remain independent.
  if(layers.z==layers.x&&layers.w==layers.y)return lower;
  float browTime=expressionTime(pixel,0.0,0.0,slot,true);
  vec4 upper=mix(sampleSource(source,a,layers.z),sampleSource(source,b,layers.w),faceTime);
  // Four painted corners keep overlapping eye/brow patches independent.
  return mix(lower,upper,browTime);
}
// Pair fields are exact at triangle edges. Interior displacement is the sum
// of barycentrically scaled pair displacements: a 2D geometric extension of
// the trained pair model, not an assertion that RIFE predicts three inputs.
void main(){
  vec2 p=secondaryUV(uv);
  if(singleSource&&!articulationEnabled){vec4 a=sampleSource(source0,p,sourceLayers[0].x);color=a;return;}
  vec2 p0=p,p1=p,p2=p;vec3 w=weights;
  if(!singleSource){
    float t01=ratio(weights.x,weights.y),t02=ratio(weights.x,weights.z),t12=ratio(weights.y,weights.z);
    vec4 d01,d02,d12;float m01,m02,m12;
    field(flow01,mask01,p,t01,reversed.x,d01,m01);
    field(flow02,mask02,p,t02,reversed.y,d02,m02);
    field(flow12,mask12,p,t12,reversed.z,d12,m12);
    p0=p+d01.xy*(weights.x+weights.y)+d02.xy*(weights.x+weights.z);
    p1=p+d01.zw*(weights.x+weights.y)+d12.xy*(weights.y+weights.z);
    p2=p+d02.zw*(weights.x+weights.z)+d12.zw*(weights.y+weights.z);
    w=weights*vec3(m01/max(.000001,1.0-t01)*m02/max(.000001,1.0-t02),
      (1.0-m01)/max(.000001,t01)*m12/max(.000001,1.0-t12),
      (1.0-m02)/max(.000001,t02)*(1.0-m12)/max(.000001,t12));
    float sum=w.x+w.y+w.z;if(sum<.000001){w=weights;sum=1.0;}w/=sum;
  }
  vec2 q0=p0,q1=p1,q2=p2;
  float influence=0.0,registeredTime=0.0,registeredAmount=0.0;
  float amounts[6];float total=0.0;
  for(int f=0;f<6;f++)amounts[f]=featureEnabled?featureInfluence(f,p*vec2(1122.0,1402.0)):0.0;
  // Eye ink has priority over a bridge which becomes occluded at steep pitch.
  // Continuous partition weights avoid an argmax UV discontinuity where masks meet.
  amounts[0]*=1.0-max(amounts[1],amounts[2]);
  for(int f=0;f<6;f++){total+=amounts[f];if(f>0){registeredTime+=amounts[f]*progress[f];registeredAmount+=amounts[f];}}
  if(registeredAmount>0.0)registeredTime/=registeredAmount;
  registeredAmount=min(1.0,registeredAmount);
  influence=min(1.0,total);
  if(total>0.0){
    vec2 a0=vec2(0.0),a1=vec2(0.0),a2=vec2(0.0),b0=vec2(0.0),b1=vec2(0.0),b2=vec2(0.0);
    for(int f=0;f<6;f++)if(amounts[f]>0.0){
      float portion=amounts[f]/total;
      a0+=featureSourceUV(f,0,p*vec2(1122.0,1402.0))*portion;a1+=featureSourceUV(f,2,p*vec2(1122.0,1402.0))*portion;a2+=featureSourceUV(f,4,p*vec2(1122.0,1402.0))*portion;
      b0+=featureSourceUV(f,1,p*vec2(1122.0,1402.0))*portion;b1+=featureSourceUV(f,3,p*vec2(1122.0,1402.0))*portion;b2+=featureSourceUV(f,5,p*vec2(1122.0,1402.0))*portion;
    }
    vec3 localInfluence=vec3(influence);
    if(hairProtectionEnabled){
      float h0=max(texture(hair0,p0).a,max(texture(hair0,a0).a,texture(hair0,b0).a));
      float h1=max(texture(hair1,p1).a,max(texture(hair1,a1).a,texture(hair1,b1).a));
      float h2=max(texture(hair2,p2).a,max(texture(hair2,a2).a,texture(hair2,b2).a));
      localInfluence*=vec3(1.0)-clamp(vec3(h0,h1,h2),vec3(0.0),vec3(1.0));
      influence=dot(weights,localInfluence);
    }
    p0=mix(p0,a0,localInfluence.x);p1=mix(p1,a1,localInfluence.y);p2=mix(p2,a2,localInfluence.z);
    q0=mix(q0,b0,localInfluence.x);q1=mix(q1,b1,localInfluence.y);q2=mix(q2,b2,localInfluence.z);
    w=mix(w,weights,influence);
  }
  vec4 a=sampleArticulated(source0,p0,q0,sourceLayers[0],0,registeredTime,registeredAmount);
  vec4 b=sampleArticulated(source1,p1,q1,sourceLayers[singleSource?0:1],singleSource?0:1,registeredTime,registeredAmount);
  vec4 c=sampleArticulated(source2,p2,q2,sourceLayers[singleSource?0:2],singleSource?0:2,registeredTime,registeredAmount);
  color=a*w.x+b*w.y+c*w.z;
}`;

export class ShortHairFlowRenderer {
  constructor(fields){
    this.fields=fields;this.canvas=document.createElement('canvas');this.canvas.width=1122;this.canvas.height=1402;
    this.gl=this.canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
    if(!this.gl)throw new Error('连续转头需要支持 WebGL 2 的浏览器；请开启浏览器硬件加速。');
    this.lost=false;this.disposed=false;this.restoreError=null;
    this.onLost=event=>{event.preventDefault();this.lost=true;};
    this.onRestored=()=>{if(this.disposed)return;try{this.initialize();this.lost=false;this.restoreError=null;}
      catch(error){this.lost=true;this.restoreError=error;}};
    this.canvas.addEventListener('webglcontextlost',this.onLost);
    this.canvas.addEventListener('webglcontextrestored',this.onRestored);
    try{this.initialize();}catch(error){this.dispose();throw error;}
  }
  initialize(){
    const gl=this.gl;
    this.program=null;this.buffer=null;this.sources=[];this.hairTextures=[];this.textures=new Map();this.sourceSignatures=[];this.hairSignatures=[];
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(`连续渲染着色器无法编译：${message}`);}return s;};
    let vertex,fragment;
    try{
      vertex=shader(gl.VERTEX_SHADER,VERTEX);fragment=shader(gl.FRAGMENT_SHADER,FRAGMENT);
      const program=this.program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('连续渲染程序无法连接。');gl.useProgram(program);
      this.uniforms=Object.fromEntries(['source0','source1','source2','flow01','flow02','flow12','mask01','mask02','mask12','weights','reversed','secondary','singleSource','featureGeometry','featureEnabled','sourceLayers[0]','articulationEnabled','progress[0]','patchOwners[0]','patchOwnersEnabled','hairProtectionEnabled','hair0','hair1','hair2']
        .map(name=>[name,gl.getUniformLocation(program,name)]));
      this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),gl.STATIC_DRAW);
      const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
      this.sources=Array.from({length:3},()=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D_ARRAY,t);this.parameters(gl.TEXTURE_2D_ARRAY);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,1122,1402,4,0,gl.RGBA,gl.UNSIGNED_BYTE,null);return t;});
      this.hairTextures=Array.from({length:3},()=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);this.parameters(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));return t;});
      this.featureTexture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.featureTexture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,12,42,0,gl.RGBA,gl.FLOAT,new Float32Array(12*42*4));
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      for(const edge of this.fields.edges){
        const pair={};this.textures.set(edge.id,pair);
        for(const kind of ['flow','mask']){
          const t=gl.createTexture();pair[kind]=t;gl.bindTexture(gl.TEXTURE_2D_ARRAY,t);this.parameters(gl.TEXTURE_2D_ARRAY);
          gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,kind==='flow'?gl.RGBA16F:gl.R8,144,180,7,0,
            kind==='flow'?gl.RGBA:gl.RED,kind==='flow'?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,edge[kind+'Data']);
        }
      }
      if(gl.getError()!==gl.NO_ERROR)throw new Error('此设备无法载入连续转头运动纹理。');
    }catch(error){this.releaseResources();throw error;}
    finally{if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);}
  }
  parameters(target){const gl=this.gl;gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
  render(vertices,sources,signatures,secondary={breath:0,sway:0,hair:0},features=null,crop=null){
    if(this.disposed||this.lost||this.gl.isContextLost()){this.lost=true;return null;}
    const frame=validateSecondaryFrame(secondary),single=vertices.length===1;
    if(![1,3].includes(vertices.length)||sources.length!==vertices.length||signatures.length!==vertices.length)throw new Error('连续渲染源数量无效。');
    if(crop!==null&&(!Array.isArray(crop)||crop.length!==4||!crop.every(Number.isSafeInteger)
      ||crop[0]<0||crop[1]<0||crop[2]<=0||crop[3]<=0||crop[0]+crop[2]>1122||crop[1]+crop[3]>1402))
      throw new TypeError('连续渲染裁切需要原画范围内的整数 [x,y,width,height]。');
    const gl=this.gl;gl.useProgram(this.program);gl.viewport(0,0,1122,1402);
    const descriptor=features&&!Array.isArray(features)?features:null;
    const from=descriptor?.from||features,to=descriptor?.to||from;
    const progress=descriptor?.progress||[0,0,0,0,0,0];
    const articulationEnabled=Boolean(descriptor&&progress.some(t=>t>0));
    const featureEnabled=Boolean(from&&descriptor?.enabled!==false&&(!single||articulationEnabled));
    const pendingSources=[...this.sourceSignatures],pendingHair=[...this.hairSignatures],sourceLayers=[];
    vertices.forEach((vertex,i)=>{
      gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.sources[i]);
      const corners=[sources[i],descriptor?.secondSources?.[i]||sources[i],descriptor?.browSources?.[i]||sources[i],descriptor?.browSecondSources?.[i]||descriptor?.secondSources?.[i]||sources[i]];
      const labels=[signatures[i],descriptor?.secondSignatures?.[i]||signatures[i],descriptor?.browSignatures?.[i]||signatures[i],descriptor?.browSecondSignatures?.[i]||descriptor?.secondSignatures?.[i]||signatures[i]];
      const seen=new Map();
      for(let corner=0;corner<4;corner++){
        if(seen.has(labels[corner])){sourceLayers.push(seen.get(labels[corner]));continue;}
        seen.set(labels[corner],corner);sourceLayers.push(corner);
        const index=i*4+corner;
        if(this.sourceSignatures[index]!==labels[corner]){
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,corner,1122,1402,1,gl.RGBA,gl.UNSIGNED_BYTE,corners[corner]);pendingSources[index]=labels[corner];
        }
      }
    });
    while(sourceLayers.length<12)sourceLayers.push(...sourceLayers.slice(0,4));
    gl.uniform4fv(this.uniforms['sourceLayers[0]'],sourceLayers);
    for(let i=0;i<3;i++)gl.uniform1i(this.uniforms['source'+i],single?0:i);
    const reversed=[];let unit=3;
    for(const [a,b] of [[0,1],[0,2],[1,2]]){
      const field=single?{edge:this.fields.edges[0],reversed:false}:findMotionField(this.fields,vertices[a].poseId,vertices[b].poseId);
      reversed.push(field.reversed?1:0);const pair=this.textures.get(field.edge.id);
      for(const kind of ['flow','mask']){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,pair[kind]);gl.uniform1i(this.uniforms[kind+a+b],unit++);}
    }
    const hairProtectionEnabled=Boolean(descriptor?.hairSources?.every(Boolean));
    for(let i=0;i<vertices.length;i++){
      gl.activeTexture(gl.TEXTURE0+10+i);gl.bindTexture(gl.TEXTURE_2D,this.hairTextures[i]);
      if(hairProtectionEnabled&&this.hairSignatures[i]!==descriptor.hairSignatures[i]){
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,descriptor.hairSources[i]);pendingHair[i]=descriptor.hairSignatures[i];
      }
    }
    for(let i=0;i<3;i++)gl.uniform1i(this.uniforms['hair'+i],hairProtectionEnabled?10+(single?0:i):10+(single?0:i));
    gl.uniform1i(this.uniforms.hairProtectionEnabled,hairProtectionEnabled?1:0);
    gl.activeTexture(gl.TEXTURE0+9);gl.bindTexture(gl.TEXTURE_2D,this.featureTexture);
    if(from){
      const expanded=[],blendWeights=[];
      for(let i=0;i<vertices.length;i++){expanded.push(from[i],to[i]);blendWeights.push(vertices[i].weight);}
      const targets=from.map((set,i)=>set.map((chart,f)=>chart&&to[i][f]?blendFeatureCharts([chart,to[i][f]],[1-progress[f],progress[f]]):null));
      const target=blendFeatureSets(targets,blendWeights);
      while(expanded.length<6)expanded.push(...expanded.slice(0,2));
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,12,42,gl.RGBA,gl.FLOAT,packFeatureGeometry(target,expanded));
    }
    gl.uniform1fv(this.uniforms['progress[0]'],progress);
    const owners=descriptor?.patchOwners;gl.uniform1i(this.uniforms.patchOwnersEnabled,owners?1:0);
    if(owners){const boxes=[...owners];while(boxes.length<3)boxes.push(owners[0]);gl.uniform4fv(this.uniforms['patchOwners[0]'],boxes.flat(2));}
    gl.uniform1i(this.uniforms.articulationEnabled,articulationEnabled?1:0);
    gl.uniform1i(this.uniforms.featureGeometry,9);gl.uniform1i(this.uniforms.featureEnabled,featureEnabled?1:0);
    gl.uniform1i(this.uniforms.singleSource,single?1:0);
    gl.uniform3fv(this.uniforms.secondary,[frame.breath,frame.sway,frame.hair]);
    gl.uniform3iv(this.uniforms.reversed,reversed);
    gl.uniform3fv(this.uniforms.weights,single?[1,0,0]:vertices.map(vertex=>vertex.weight));
    // Do not publish or cache a failed upload. The display canvas remains
    // untouched and the next attempt retries every affected source signature.
    if(gl.getError()!==gl.NO_ERROR)throw new Error('连续五官纹理上传失败，请重新载入画稿。');
    this.sourceSignatures=pendingSources;this.hairSignatures=pendingHair;
    // Keep native canvas/viewport/UV coordinates and clear the whole surface.
    // Scissor only removes fragments the caller will not read from this draw.
    gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    try{
      if(crop){gl.enable(gl.SCISSOR_TEST);gl.scissor(crop[0],1402-crop[1]-crop[3],crop[2],crop[3]);}
      gl.drawArrays(gl.TRIANGLES,0,6);
    }finally{gl.disable(gl.SCISSOR_TEST);}
    if(this.lost||gl.isContextLost()){this.lost=true;return null;}
    return this.canvas;
  }
  releaseResources(){
    const gl=this.gl;for(const texture of [...this.sources||[],...this.hairTextures||[]])gl.deleteTexture(texture);
    for(const pair of this.textures?.values()||[])for(const texture of Object.values(pair))gl.deleteTexture(texture);
    if(this.featureTexture)gl.deleteTexture(this.featureTexture);this.featureTexture=null;
    if(this.buffer)gl.deleteBuffer(this.buffer);if(this.program)gl.deleteProgram(this.program);
    this.sources=[];this.hairTextures=[];this.textures?.clear();this.buffer=null;this.program=null;this.sourceSignatures=[];this.hairSignatures=[];
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    this.canvas.removeEventListener('webglcontextlost',this.onLost);this.canvas.removeEventListener('webglcontextrestored',this.onRestored);
    this.releaseResources();this.gl.getExtension('WEBGL_lose_context')?.loseContext();this.lost=true;
  }
}
