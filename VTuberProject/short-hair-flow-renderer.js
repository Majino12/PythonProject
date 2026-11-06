import {findMotionField} from './short-hair-motion-fields.js';

const VERTEX=`#version 300 es
in vec2 position;out vec2 uv;
void main(){uv=vec2(position.x,1.0-position.y);gl_Position=vec4(position*2.0-1.0,0.0,1.0);}`;
const FRAGMENT=`#version 300 es
precision highp float;precision highp sampler2DArray;
in vec2 uv;out vec4 color;
uniform sampler2D source0,source1,source2;
uniform sampler2DArray flow01,flow02,flow12,mask01,mask02,mask12;
uniform vec3 weights;uniform bvec3 reversed;
// The seven sampled times are true RIFE estimates. Interpolation between them
// is interpolation of motion/visibility, not a dissolve of unaligned paintings.
void field(sampler2DArray flow,sampler2DArray mask,float time,bool reverse,out vec4 d,out float m){
  float t=reverse?1.0-time:time;
  float z=clamp(t*8.0-1.0,0.0,6.0),a=floor(z),b=min(6.0,a+1.0);
  d=mix(texture(flow,vec3(uv,a)),texture(flow,vec3(uv,b)),z-a);
  m=mix(texture(mask,vec3(uv,a)).r,texture(mask,vec3(uv,b)).r,z-a);
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
  float t01=ratio(weights.x,weights.y),t02=ratio(weights.x,weights.z),t12=ratio(weights.y,weights.z);
  vec4 d01,d02,d12;float m01,m02,m12;
  field(flow01,mask01,t01,reversed.x,d01,m01);
  field(flow02,mask02,t02,reversed.y,d02,m02);
  field(flow12,mask12,t12,reversed.z,d12,m12);
  vec2 p0=uv+d01.xy*(weights.x+weights.y)+d02.xy*(weights.x+weights.z);
  vec2 p1=uv+d01.zw*(weights.x+weights.y)+d12.xy*(weights.y+weights.z);
  vec2 p2=uv+d02.zw*(weights.x+weights.z)+d12.zw*(weights.y+weights.z);
  vec3 w=weights*vec3(m01/max(.000001,1.0-t01)*m02/max(.000001,1.0-t02),
    (1.0-m01)/max(.000001,t01)*m12/max(.000001,1.0-t12),
    (1.0-m02)/max(.000001,t02)*(1.0-m12)/max(.000001,t12));
  float sum=w.x+w.y+w.z;if(sum<.000001){w=weights;sum=1.0;}w/=sum;
  vec4 a=sampleSource(source0,p0),b=sampleSource(source1,p1),c=sampleSource(source2,p2);
  // Premultiplied-alpha interpolation uses the SAME motion and visibility for
  // RGB and matte, avoiding separately inferred alpha swimming at hair edges.
  color=vec4(a.rgb*a.a*w.x+b.rgb*b.a*w.y+c.rgb*c.a*w.z,a.a*w.x+b.a*w.y+c.a*w.z);
}`;

export class ShortHairFlowRenderer {
  constructor(fields){
    this.fields=fields;this.canvas=document.createElement('canvas');this.canvas.width=1122;this.canvas.height=1402;
    const gl=this.gl=this.canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
    if(!gl)throw new Error('连续转头需要支持 WebGL 2 的浏览器；请开启浏览器硬件加速。');
    this.lost=false;this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.lost=true;});
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(`连续渲染着色器无法编译：${gl.getShaderInfoLog(s)}`);return s;};
    const program=this.program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,VERTEX));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,FRAGMENT));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('连续渲染程序无法连接。');gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),gl.STATIC_DRAW);
    const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
    this.sources=Array.from({length:3},()=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);this.parameters(gl.TEXTURE_2D);return t;});
    this.textures=new Map();this.sourceSignatures=[];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    for(const edge of fields.edges){
      const pair={};for(const kind of ['flow','mask']){
        const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D_ARRAY,t);this.parameters(gl.TEXTURE_2D_ARRAY);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,kind==='flow'?gl.RGBA16F:gl.R8,144,180,7,0,
          kind==='flow'?gl.RGBA:gl.RED,kind==='flow'?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,edge[kind+'Data']);pair[kind]=t;
      }this.textures.set(edge.id,pair);
    }
    if(gl.getError()!==gl.NO_ERROR)throw new Error('此设备无法载入连续转头运动纹理。');
  }
  parameters(target){const gl=this.gl;gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);}
  render(vertices,sources,signatures){
    if(this.lost)throw new Error('连续转头图形上下文已丢失，请重新载入角色。');
    const gl=this.gl;gl.useProgram(this.program);gl.viewport(0,0,1122,1402);
    vertices.forEach((vertex,i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,this.sources[i]);
      if(this.sourceSignatures[i]!==signatures[i]){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,sources[i]);this.sourceSignatures[i]=signatures[i];}
      gl.uniform1i(gl.getUniformLocation(this.program,'source'+i),i);});
    const reversed=[];let unit=3;
    for(const [a,b] of [[0,1],[0,2],[1,2]]){
      const field=findMotionField(this.fields,vertices[a].poseId,vertices[b].poseId);reversed.push(field.reversed?1:0);
      const pair=this.textures.get(field.edge.id);
      for(const kind of ['flow','mask']){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D_ARRAY,pair[kind]);
        gl.uniform1i(gl.getUniformLocation(this.program,kind+a+b),unit++);}
    }
    gl.uniform3iv(gl.getUniformLocation(this.program,'reversed'),reversed);
    gl.uniform3fv(gl.getUniformLocation(this.program,'weights'),vertices.map(vertex=>vertex.weight));
    gl.disable(gl.BLEND);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,6);
    return this.canvas;
  }
  dispose(){const extension=this.gl.getExtension('WEBGL_lose_context');extension?.loseContext();this.textures.clear();}
}
