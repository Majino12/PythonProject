import {ShortHairMeshRenderer} from './short-hair-mesh-renderer.js';
const makeCanvas=()=>{const c=document.createElement('canvas');c.width=1122;c.height=1402;return c;};

/** Combines the CURRENT painted expression with its hidden surface and moving
 * front hair/contact residual. Every pose retains its own committed canvas;
 * the mesh renderer's shared GL canvas is copied before another pose draws.
 * Source and hidden assets are caller-owned. This class owns only its GPU and
 * two output buffers per visited pose. It advances no clocks or source state. */
export class ShortHairFringeRenderer {
  constructor(assets,{meshRenderer=null}={}){
    if(!assets||!assets.poses||typeof assets.poses!=='object'||Array.isArray(assets.poses))throw new TypeError('缺少已登记的前发分层素材。');
    this.assets=assets;this.meshRenderer=meshRenderer||new ShortHairMeshRenderer();this.buffers=new Map();this.disposed=false;
  }
  get lost(){return this.meshRenderer.lost;}
  get restoreError(){return this.meshRenderer.restoreError;}
  render(source,poseId,controls={x:0,y:0},{signature=''}={}){
    if(this.disposed)return null;
    const pose=Object.hasOwn(this.assets.poses,poseId)?this.assets.poses[poseId]:null;
    if(!pose||!pose.binding.runtimeValidated||(controls.x===0&&controls.y===0))return source;
    if(this.restoreError)throw this.restoreError;if(this.lost)return null;
    if(typeof signature!=='string')throw new TypeError('动态前发输入签名无效。');
    const outputSignature=JSON.stringify([signature,pose.signature,controls.x,controls.y]);let buffer=this.buffers.get(poseId);
    if(buffer?.signature===outputSignature&&buffer.source===source)return buffer.front;
    const material={underpaint:pose.underpaint,weight:pose.weight,ownership:pose.ownership,signature:pose.signature};
    const foreground=this.meshRenderer.render(source,pose.binding,controls,{signature,material});if(!foreground||this.lost)return null;
    if(!buffer){buffer={front:makeCanvas(),back:makeCanvas(),source:null,signature:null};this.buffers.set(poseId,buffer);}
    // Only the spare buffer is touched until all painting and GPU checks pass.
    const c=buffer.back.getContext('2d');c.setTransform(1,0,0,1,0,0);c.globalCompositeOperation='source-over';c.globalAlpha=1;c.clearRect(0,0,1122,1402);
    c.drawImage(source,0,0);c.drawImage(pose.weightedUnderpaint,0,0);c.drawImage(foreground,0,0);
    if(this.lost)return null;
    [buffer.front,buffer.back]=[buffer.back,buffer.front];buffer.source=source;buffer.signature=outputSignature;return buffer.front;
  }
  dispose(){if(this.disposed)return;this.disposed=true;try{this.meshRenderer.dispose();}
    finally{for(const record of this.buffers.values())for(const canvas of [record.front,record.back]){canvas.width=0;canvas.height=0;}this.buffers.clear();}
  }
}
