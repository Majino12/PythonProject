import test from 'node:test';
import assert from 'node:assert/strict';
import {ShortHairFringeRenderer} from './short-hair-fringe-renderer.js';
function harness(options={}){
  let id=0;const created=[],calls=[],mesh={lost:false,restoreError:null,disposed:0,fail:false,canvas:{gpu:true},
    render(...args){calls.push(args);return this.fail?null:this.canvas;},dispose(){this.disposed++;}};
  const createElement=()=>{const canvas={width:0,height:0,id:++id,paint:[],getContext(){return{setTransform(){},clearRect(){canvas.paint=[];},drawImage(image){if(image.fail)throw new Error('paint failed');canvas.paint.push(image);}};}};created.push(canvas);return canvas;};
  const assets={poses:Object.fromEntries(['front','view-left','candidate'].map(poseId=>[poseId,{binding:{runtimeValidated:poseId!=='candidate'},underpaint:{u:poseId},weightedUnderpaint:{weighted:poseId},weight:{w:poseId},ownership:{h:poseId},signature:'static-'+poseId}]))};
  const previous=globalThis.document;globalThis.document={createElement};
  const renderer=new ShortHairFringeRenderer(assets,{meshRenderer:mesh,...options});
  return {renderer,assets,mesh,calls,created,restore(){globalThis.document=previous;}};
}
const active={x:.5,y:.09};
test('fringe compositing orders dynamic D, weighted U and mesh foreground; returned pose canvases are distinct',()=>{
  const h=harness();try{const a={},b={},front=h.renderer.render(a,'front',active,{signature:'expression-a'}),left=h.renderer.render(b,'view-left',active,{signature:'expression-b'});
    assert.notStrictEqual(front,left);assert.notStrictEqual(front,h.mesh.canvas);assert.deepEqual(front.paint,[a,h.assets.poses.front.weightedUnderpaint,h.mesh.canvas]);
    assert.deepEqual(left.paint,[b,h.assets.poses['view-left'].weightedUnderpaint,h.mesh.canvas]);
    assert.strictEqual(h.calls[0][0],a);assert.strictEqual(h.calls[0][3].material.underpaint,h.assets.poses.front.underpaint);
    assert.equal(h.renderer.buffers.size,2);
  }finally{h.renderer.dispose();h.restore();}
});
test('cached composition follows source, pose material and controls without repainting an identical frame',()=>{
  const h=harness();try{const d={},first=h.renderer.render(d,'front',active,{signature:'a'});assert.strictEqual(h.renderer.render(d,'front',active,{signature:'a'}),first);assert.equal(h.calls.length,1);
    const second=h.renderer.render(d,'front',{x:-.5,y:-.09},{signature:'a'});assert.notStrictEqual(first,second);assert.equal(h.calls.length,2);
    h.renderer.render(d,'front',active,{signature:'b'});assert.equal(h.calls.length,3);h.assets.poses.front.signature='changed-static';h.renderer.render(d,'front',active,{signature:'b'});assert.equal(h.calls.length,4);
  }finally{h.renderer.dispose();h.restore();}
});
test('zero, unavailable and unvalidated poses preserve source identity without allocating outputs',()=>{
  const h=harness();try{const d={};for(const [id,c]of [['front',{x:0,y:0}],['missing',active],['__proto__',active],['candidate',active]])assert.strictEqual(h.renderer.render(d,id,c),d);
    assert.equal(h.calls.length,0);assert.equal(h.created.length,0);
  }finally{h.renderer.dispose();h.restore();}
});
test('failed mesh or base painting cannot commit or overwrite the last composed pose',()=>{
  const h=harness();try{const d={},first=h.renderer.render(d,'front',active,{signature:'a'}),paint=[...first.paint],record=h.renderer.buffers.get('front');
    h.mesh.fail=true;assert.equal(h.renderer.render(d,'front',active,{signature:'b'}),null);assert.strictEqual(record.front,first);assert.equal(record.signature,JSON.stringify(['a','static-front',.5,.09]));
    h.mesh.fail=false;h.assets.poses.front.weightedUnderpaint.fail=true;assert.throws(()=>h.renderer.render(d,'front',active,{signature:'b'}),/paint failed/);assert.strictEqual(record.front,first);assert.deepEqual(first.paint,paint);
    h.assets.poses.front.weightedUnderpaint.fail=false;assert.notStrictEqual(h.renderer.render(d,'front',active,{signature:'b'}),first);
  }finally{h.renderer.dispose();h.restore();}
});
test('mesh loss and restore errors preserve cached frames; disposal releases output storage once',()=>{
  const h=harness();try{const d={};h.renderer.render(d,'front',active,{signature:'a'});h.mesh.lost=true;assert.equal(h.renderer.render(d,'front',active,{signature:'a'}),null);assert.equal(h.calls.length,1);
    h.mesh.lost=false;const failure=new Error('restore failed');h.mesh.restoreError=failure;assert.throws(()=>h.renderer.render(d,'front',active,{signature:'a'}),e=>e===failure);
    h.renderer.dispose();h.renderer.dispose();assert.equal(h.mesh.disposed,1);assert.equal(h.renderer.buffers.size,0);assert.ok(h.created.every(c=>c.width===0&&c.height===0));assert.equal(h.renderer.render(d,'front',active),null);
  }finally{h.restore();}
});

test('four retained corners stay distinct across cache hits and changing call order',()=>{
  const h=harness({retainedFrames:4});try{
    const sources=Array.from({length:5},(_,index)=>({index}));
    const first=sources.slice(0,4).map((source,i)=>h.renderer.render(source,'front',active,{signature:String(i)}));
    assert.equal(new Set(first).size,4);assert.equal(h.created.length,4);assert.equal(h.calls.length,4);
    first.forEach((canvas,i)=>assert.strictEqual(canvas.paint[0],sources[i]));
    for(const i of [3,0,2,1])assert.strictEqual(h.renderer.render(sources[i],'front',active,{signature:String(i)}),first[i]);
    assert.equal(h.calls.length,4);
    const fifth=h.renderer.render(sources[4],'front',active,{signature:'4'});
    assert.strictEqual(fifth,first[3]);for(const i of [0,1,2])assert.strictEqual(first[i].paint[0],sources[i]);
    assert.equal(new Set([first[0],first[1],first[2],fifth]).size,4);
  }finally{h.renderer.dispose();assert.ok(h.created.every(c=>c.width===0&&c.height===0));h.restore();}
});
test('failed replacement invalidates its old cache identity while preserving the most recent retained corner',()=>{
  const h=harness({retainedFrames:4});try{
    const sources=Array.from({length:5},(_,index)=>({index})),out=sources.slice(0,4).map((source,i)=>h.renderer.render(source,'front',active,{signature:String(i)}));
    const committed=[...out[3].paint];h.assets.poses.front.weightedUnderpaint.fail=true;
    assert.throws(()=>h.renderer.render(sources[4],'front',active,{signature:'4'}),/paint failed/);
    assert.strictEqual(h.renderer.buffers.get('front').front,out[3]);assert.deepEqual(out[3].paint,committed);
    h.assets.poses.front.weightedUnderpaint.fail=false;const count=h.calls.length;
    const recovered=h.renderer.render(sources[0],'front',active,{signature:'0'});assert.equal(h.calls.length,count+1);assert.strictEqual(recovered.paint[0],sources[0]);
  }finally{h.renderer.dispose();h.restore();}
});
test('four-frame retention remains per pose and disposal releases every allocated canvas exactly once',()=>{
  const h=harness({retainedFrames:4});try{
    const returned=[];for(const pose of ['front','view-left'])for(let i=0;i<4;i++)returned.push(h.renderer.render({pose,i},pose,active,{signature:String(i)}));
    assert.equal(new Set(returned).size,8);assert.equal(h.created.length,8);h.renderer.dispose();h.renderer.dispose();
    assert.equal(h.mesh.disposed,1);assert.ok(returned.every(c=>c.width===0&&c.height===0));assert.equal(h.renderer.buffers.size,0);
  }finally{h.restore();}
});
test('retention defaults to two and rejects unbounded or noninteger pools before allocating a GPU',()=>{
  const h=harness();try{assert.equal(h.renderer.retainedFrames,2);h.renderer.render({},'front',active,{signature:'a'});assert.equal(h.created.length,2);}finally{h.renderer.dispose();h.restore();}
  for(const retainedFrames of [0,1,5,2.5,NaN,'4'])assert.throws(()=>new ShortHairFringeRenderer({poses:{}},{meshRenderer:{},retainedFrames}),/2–4/);
});
