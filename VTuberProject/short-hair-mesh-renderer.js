import {deformHairMesh,HAIR_MESH_SIZE} from './short-hair-mesh-model.js';

const VERTEX=`#version 300 es
in vec2 sourcePosition;in vec2 targetPosition;out vec2 uv;
void main(){uv=sourcePosition/vec2(1122.0,1402.0);vec2 p=targetPosition/vec2(1122.0,1402.0);gl_Position=vec4(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);}`;
const FRAGMENT=`#version 300 es
precision highp float;in vec2 uv;out vec4 color;
uniform sampler2D source,underpaint,weight,ownership;uniform bool materialEnabled;
// Every texture uploads premultiplied RGBA. W/H are carried by alpha.
// A material's support is registered strictly inside opaque source skin/hair;
// its hidden painting must also be opaque wherever W is nonzero.
void main(){
  vec4 original=texture(source,uv);
  if(!materialEnabled){color=original;return;}
  float w=texture(weight,uv).a,h=texture(ownership,uv).a;
  if(max(w,h)<=0.0){color=vec4(0.0);return;}
  vec4 hidden=texture(underpaint,uv);
  vec3 d=original.rgb/max(original.a,0.000001),u=hidden.rgb/max(hidden.a,0.000001);
  // Match the caller's 8-bit Canvas2D base before solving its residual.
  vec3 base=floor(mix(d,u,w)*255.0+0.5)/255.0;
  vec3 darker=max(base-d,vec3(0.0))/max(base,vec3(0.000001));
  vec3 lighter=max(d-base,vec3(0.0))/max(vec3(1.0)-base,vec3(0.000001));
  vec3 required=max(darker,lighter);float a=max(required.r,max(required.g,required.b));
  // Both decompositions reconstruct D over B; interpolation at a binary-H
  // texture boundary remains a valid decomposition, without a hard threshold.
  a=mix(clamp(a,0.0,1.0),1.0,h);
  a=min(1.0,ceil(a*255.0)/255.0);
  vec3 premultiplied=clamp(d-(1.0-a)*base,vec3(0.0),vec3(a));
  color=vec4(premultiplied,a);
}`;
const dimensions=source=>[source?.naturalWidth??source?.width,source?.naturalHeight??source?.height];

/** Draws ONLY a registered foreground-hair cutout. The caller composites it
 * over its current, non-deformed face/body/hidden-surface canvas and copies
 * this shared output before rendering another pose for RIFE. One context,
 * at most nine native source textures and geometry records, no private clock.
 * Optional material adds three static textures per pose: opaque underpaint U,
 * alpha weight W and alpha ownership H. In that mode source is the CURRENT
 * dynamic composition D, not an old neutral hair cutout. Only masked interior
 * support may use material mode; the caller validates opacity/support once. */
export class ShortHairMeshRenderer {
  constructor(){
    this.canvas=document.createElement('canvas');[this.canvas.width,this.canvas.height]=HAIR_MESH_SIZE;
    this.gl=this.canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
    if(!this.gl)throw new Error('前发网格需要支持 WebGL 2 的浏览器。');
    this.lost=false;this.disposed=false;this.restoreError=null;
    this.onLost=event=>{event.preventDefault();this.lost=true;};
    this.onRestored=()=>{if(this.disposed)return;try{this.initialize();this.lost=false;this.restoreError=null;}catch(error){this.lost=true;this.restoreError=error;}};
    this.canvas.addEventListener('webglcontextlost',this.onLost);this.canvas.addEventListener('webglcontextrestored',this.onRestored);
    try{this.initialize();}catch(error){this.dispose();throw error;}
  }
  initialize(){
    const gl=this.gl;this.program=null;this.textures=new Map();this.materials=new Map();this.geometry=new Map();
    const shader=(type,source)=>{const result=gl.createShader(type);if(!result)throw new Error('无法建立前发网格着色器。');
      gl.shaderSource(result,source);gl.compileShader(result);if(!gl.getShaderParameter(result,gl.COMPILE_STATUS)){const message=gl.getShaderInfoLog(result);gl.deleteShader(result);throw new Error(`前发网格着色器无法编译：${message}`);}return result;};
    let vertex,fragment;
    try{
      vertex=shader(gl.VERTEX_SHADER,VERTEX);fragment=shader(gl.FRAGMENT_SHADER,FRAGMENT);
      this.program=gl.createProgram();gl.attachShader(this.program,vertex);gl.attachShader(this.program,fragment);gl.linkProgram(this.program);
      if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error('前发网格程序无法连接。');
      this.sourceLocation=gl.getAttribLocation(this.program,'sourcePosition');this.targetLocation=gl.getAttribLocation(this.program,'targetPosition');
      this.textureLocation=gl.getUniformLocation(this.program,'source');
      this.materialLocations=Object.fromEntries(['underpaint','weight','ownership','materialEnabled'].map(name=>[name,gl.getUniformLocation(this.program,name)]));
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      if(gl.getError()!==gl.NO_ERROR)throw new Error('此设备无法初始化前发网格。');
    }catch(error){this.releaseResources();throw error;}
    finally{if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);}
  }
  releaseGeometry(record){if(!record)return;for(const buffer of [record.source,record.target,record.indices])if(buffer)this.gl.deleteBuffer(buffer);}
  meshBuffers(binding){
    const gl=this.gl,previous=this.geometry.get(binding.poseId);if(previous?.binding===binding)return previous;
    if(previous){this.releaseGeometry(previous);this.geometry.delete(binding.poseId);}
    const record={binding,source:null,target:null,indices:null};
    try{
      record.source=gl.createBuffer();record.target=gl.createBuffer();record.indices=gl.createBuffer();
      if(!record.source||!record.target||!record.indices)throw new Error('无法建立前发网格缓冲。');
      gl.bindBuffer(gl.ARRAY_BUFFER,record.source);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(binding.positions),gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER,record.target);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(binding.positions),gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,record.indices);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(binding.triangles),gl.STATIC_DRAW);
      this.geometry.set(binding.poseId,record);return record;
    }catch(error){this.releaseGeometry(record);throw error;}
  }
  sourceTexture(poseId,source,signature){
    const gl=this.gl;let record=this.textures.get(poseId);
    if(!record){const texture=gl.createTexture();if(!texture)throw new Error('无法建立前发纹理。');record={texture,source:null,signature:null};this.textures.set(poseId,record);
      gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    }else gl.bindTexture(gl.TEXTURE_2D,record.texture);
    if(record.source!==source||record.signature!==signature){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);record.source=source;record.signature=signature;}
    return record;
  }
  materialTextures(poseId,material){
    const gl=this.gl;let record=this.materials.get(poseId);
    if(!record){record={signature:null,entries:{}};this.materials.set(poseId,record);}
    for(const [i,name]of ['underpaint','weight','ownership'].entries()){
      gl.activeTexture(gl.TEXTURE0+1+i);let entry=record.entries[name];
      if(!entry){const texture=gl.createTexture();if(!texture)throw new Error('无法建立前发补画材质纹理。');entry={texture,source:null};record.entries[name]=entry;
        gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      }else gl.bindTexture(gl.TEXTURE_2D,entry.texture);
      if(entry.source!==material[name]||record.signature!==material.signature){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,material[name]);entry.source=material[name];}
      gl.uniform1i(this.materialLocations[name],1+i);
    }
    record.signature=material.signature;return record;
  }

  render(source,binding,controls={x:0,y:0},{signature='',enabled=true,original=false,material=null}={}){
    if(this.disposed)return null;
    if(dimensions(source).some((n,i)=>n!==HAIR_MESH_SIZE[i]))throw new TypeError('前发网格只接受 1122×1402 原生图层。');
    if(typeof signature!=='string'||signature.length>100000)throw new TypeError('前发纹理签名无效。');
    if(material!==null){
      const keys=['underpaint','weight','ownership','signature'];
      if(typeof material!=='object'||Array.isArray(material)||Object.keys(material).length!==keys.length||keys.some(key=>!Object.hasOwn(material,key))
        ||typeof material.signature!=='string'||material.signature.length>100000
        ||keys.slice(0,3).some(key=>dimensions(material[key]).some((n,i)=>n!==HAIR_MESH_SIZE[i])))throw new TypeError('前发补画材质需要原生尺寸 U/W/H 与静态签名，W/H 使用 alpha 通道。');
    }
    const frame=deformHairMesh(binding,controls,{enabled,original});
    // Exact identity path; even antialiasing/premultiplication round trips are
    // avoided. Candidate/unsupported poses have this same fail-closed path.
    if(!frame.moved)return source;
    if(this.restoreError)throw this.restoreError;
    if(this.lost||this.gl.isContextLost()){this.lost=true;return null;}
    const gl=this.gl,record=this.meshBuffers(binding);gl.useProgram(this.program);gl.viewport(0,0,...HAIR_MESH_SIZE);
    gl.activeTexture(gl.TEXTURE0);this.sourceTexture(binding.poseId,source,signature);gl.uniform1i(this.textureLocation,0);
    gl.uniform1i(this.materialLocations.materialEnabled,material?1:0);
    if(material)this.materialTextures(binding.poseId,material);
    else for(const name of ['underpaint','weight','ownership'])gl.uniform1i(this.materialLocations[name],0);
    gl.bindBuffer(gl.ARRAY_BUFFER,record.source);gl.enableVertexAttribArray(this.sourceLocation);gl.vertexAttribPointer(this.sourceLocation,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,record.target);gl.bufferSubData(gl.ARRAY_BUFFER,0,new Float32Array(frame.positions));gl.enableVertexAttribArray(this.targetLocation);gl.vertexAttribPointer(this.targetLocation,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,record.indices);gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES,binding.triangles.length,gl.UNSIGNED_SHORT,0);
    if(this.lost||gl.isContextLost()){this.lost=true;return null;}return this.canvas;
  }
  releaseResources(){
    for(const record of this.geometry?.values()||[])this.releaseGeometry(record);this.geometry?.clear();
    for(const record of this.textures?.values()||[])this.gl.deleteTexture(record.texture);this.textures?.clear();
    for(const record of this.materials?.values()||[])for(const entry of Object.values(record.entries))this.gl.deleteTexture(entry.texture);this.materials?.clear();
    if(this.program)this.gl.deleteProgram(this.program);this.program=null;
  }
  dispose(){if(this.disposed)return;this.disposed=true;
    this.canvas.removeEventListener('webglcontextlost',this.onLost);this.canvas.removeEventListener('webglcontextrestored',this.onRestored);
    this.releaseResources();this.gl.getExtension('WEBGL_lose_context')?.loseContext();this.lost=true;
  }
}
