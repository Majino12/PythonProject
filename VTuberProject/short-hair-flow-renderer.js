import {findMotionField} from './short-hair-motion-fields.js';
import {validateSecondaryFrame} from './short-hair-secondary-motion.js';

const VERTEX=`#version 300 es
in vec2 position;out vec2 uv;
void main(){uv=vec2(position.x,1.0-position.y);gl_Position=vec4(position*2.0-1.0,0.0,1.0);}`;
const FRAGMENT=`#version 300 es
precision highp float;precision highp sampler2DArray;
in vec2 uv;out vec4 color;
uniform sampler2D source0,source1,source2;
uniform sampler2DArray flow01,flow02,flow12,mask01,mask02,mask12;
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
vec4 sampleSource(sampler2D source,vec2 p){
  return texture(source,clamp(p,vec2(0.0),vec2(1.0)));
}
float ratio(float a,float b){return b/max(.000001,a+b);}
// Pair fields are exact at triangle edges. Interior displacement is the sum
// of barycentrically scaled pair displacements: a 2D geometric extension of
// the trained pair model, not an assertion that RIFE predicts three inputs.
void main(){
  vec2 p=secondaryUV(uv);
  if(singleSource){vec4 a=sampleSource(source0,p);color=vec4(a.rgb*a.a,a.a);return;}
  float t01=ratio(weights.x,weights.y),t02=ratio(weights.x,weights.z),t12=ratio(weights.y,weights.z);
  vec4 d01,d02,d12;float m01,m02,m12;
  field(flow01,mask01,p,t01,reversed.x,d01,m01);
  field(flow02,mask02,p,t02,reversed.y,d02,m02);
  field(flow12,mask12,p,t12,reversed.z,d12,m12);
  vec2 p0=p+d01.xy*(weights.x+weights.y)+d02.xy*(weights.x+weights.z);
  vec2 p1=p+d01.zw*(weights.x+weights.y)+d12.xy*(weights.y+weights.z);
  vec2 p2=p+d02.zw*(weights.x+weights.z)+d12.zw*(weights.y+weights.z);
  vec3 w=weights*vec3(m01/max(.000001,1.0-t01)*m02/max(.000001,1.0-t02),
    (1.0-m01)/max(.000001,t01)*m12/max(.000001,1.0-t12),
    (1.0-m02)/max(.000001,t02)*(1.0-m12)/max(.000001,t12));
  float sum=w.x+w.y+w.z;if(sum<.000001){w=weights;sum=1.0;}w/=sum;
  vec4 a=sampleSource(source0,p0),b=sampleSource(source1,p1),c=sampleSource(source2,p2);
  color=vec4(a.rgb*a.a*w.x+b.rgb*b.a*w.y+c.rgb*c.a*w.z,a.a*w.x+b.a*w.y+c.a*w.z);
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
    this.program=null;this.buffer=null;this.sources=[];this.textures=new Map();this.sourceSignatures=[];
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(`连续渲染着色器无法编译：${message}`);}return s;};
    let vertex,fragment;
    try{
      vertex=shader(gl.VERTEX_SHADER,VERTEX);fragment=shader(gl.FRAGMENT_SHADER,FRAGMENT);
      const program=this.program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('连续渲染程序无法连接。');gl.useProgram(program);
      this.uniforms=Object.fromEntries(['source0','source1','source2','flow01','flow02','flow12','mask01','mask02','mask12','weights','reversed','secondary','singleSource']
        .map(name=>[name,gl.getUniformLocation(program,name)]));
      this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),gl.STATIC_DRAW);
      const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
      this.sources=Array.from({length:3},()=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);this.parameters(gl.TEXTURE_2D);return t;});
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
  render(vertices,sources,signatures,secondary={breath:0,sway:0,hair:0}){
    if(this.disposed||this.lost||this.gl.isContextLost()){this.lost=true;return null;}
    const frame=validateSecondaryFrame(secondary),single=vertices.length===1;
    if(![1,3].includes(vertices.length)||sources.length!==vertices.length||signatures.length!==vertices.length)throw new Error('连续渲染源数量无效。');
    const gl=this.gl;gl.useProgram(this.program);gl.viewport(0,0,1122,1402);
    vertices.forEach((vertex,i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.sources[i]);
      if(this.sourceSignatures[i]!==signatures[i]){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,sources[i]);this.sourceSignatures[i]=signatures[i];}});
    for(let i=0;i<3;i++)gl.uniform1i(this.uniforms['source'+i],single?0:i);
    const reversed=[];let unit=3;
    for(const [a,b] of [[0,1],[0,2],[1,2]]){
      const field=single?{edge:this.fields.edges[0],reversed:false}:findMotionField(this.fields,vertices[a].poseId,vertices[b].poseId);
      reversed.push(field.reversed?1:0);const pair=this.textures.get(field.edge.id);
      for(const kind of ['flow','mask']){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,pair[kind]);gl.uniform1i(this.uniforms[kind+a+b],unit++);}
    }
    gl.uniform1i(this.uniforms.singleSource,single?1:0);
    gl.uniform3fv(this.uniforms.secondary,[frame.breath,frame.sway,frame.hair]);
    gl.uniform3iv(this.uniforms.reversed,reversed);
    gl.uniform3fv(this.uniforms.weights,single?[1,0,0]:vertices.map(vertex=>vertex.weight));
    gl.disable(gl.BLEND);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,6);
    if(this.lost||gl.isContextLost()){this.lost=true;return null;}
    return this.canvas;
  }
  releaseResources(){
    const gl=this.gl;for(const texture of this.sources||[])gl.deleteTexture(texture);
    for(const pair of this.textures?.values()||[])for(const texture of Object.values(pair))gl.deleteTexture(texture);
    if(this.buffer)gl.deleteBuffer(this.buffer);if(this.program)gl.deleteProgram(this.program);
    this.sources=[];this.textures?.clear();this.buffer=null;this.program=null;this.sourceSignatures=[];
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    this.canvas.removeEventListener('webglcontextlost',this.onLost);this.canvas.removeEventListener('webglcontextrestored',this.onRestored);
    this.releaseResources();this.gl.getExtension('WEBGL_lose_context')?.loseContext();this.lost=true;
  }
}
