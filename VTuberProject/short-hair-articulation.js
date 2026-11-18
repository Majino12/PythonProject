/** Continuous progress between registered, authored facial paintings.
 * This module owns timing/graph geometry only: the renderer must align the
 * corresponding feature geometry before combining any two source textures.
 * A fractional descriptor is not permission to dissolve unregistered artwork. */
export const ARTICULATION_GROUPS=Object.freeze(['eyeLeft','eyeRight','mouth','browLeft','browRight']);
export const ARTICULATION_EYES=Object.freeze(['open','quarter','half','threeQuarter','closed']);
export const ARTICULATION_JAW=Object.freeze(['neutral','parted','openSmall','openMedium','openWide']);
export const ARTICULATION_SPECIAL_MOUTHS=Object.freeze(['pucker','press','shiftLeft','shiftRight']);
export const ARTICULATION_BROWS=Object.freeze(['neutral','up','innerUp','outerUp','down']);
export const ARTICULATION_DEFAULT_STATE=Object.freeze({eyeLeft:'open',eyeRight:'open',mouth:'neutral',browLeft:'neutral',browRight:'neutral'});
export const ARTICULATION_MAX_STEP=.5;
export const ARTICULATION_MAX_FRAME_MS=1000/30;
export const ARTICULATION_TIMING=Object.freeze({
  natural:Object.freeze({eyeClose:36,eyeOpen:48,jawOpen:60,jawClose:45,mouthSpecial:150,brow:160}),
  quick:Object.freeze({eyeClose:28,eyeOpen:36,jawOpen:45,jawClose:36,mouthSpecial:110,brow:120}),
});

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const chain=states=>states.slice(1).map((state,index)=>[states[index],state]);
const eyeEdges=chain(ARTICULATION_EYES),mouthEdges=[...chain(ARTICULATION_JAW),...ARTICULATION_SPECIAL_MOUTHS.map(state=>['neutral',state])];
const browEdges=ARTICULATION_BROWS.slice(1).map(state=>['neutral',state]);
const edgesFor=group=>group.startsWith('eye')?eyeEdges:group==='mouth'?mouthEdges:browEdges;
const statesFor=group=>group.startsWith('eye')?ARTICULATION_EYES:group==='mouth'?[...ARTICULATION_JAW,...ARTICULATION_SPECIAL_MOUTHS]:ARTICULATION_BROWS;
const adjacent=(group,from,to)=>edgesFor(group).some(([a,b])=>a===from&&b===to||a===to&&b===from);
const endpoint=state=>({from:state,to:state,t:0});

/** Canonical endpoints use {from:state,to:state,t:0}. Interior orientations
 * are preserved; reversing a target need not swap already displayed textures. */
function canonical(frame){
  if(frame.from===frame.to||frame.t<=1e-12)return endpoint(frame.from);
  if(frame.t>=1-1e-12)return endpoint(frame.to);
  return {from:frame.from,to:frame.to,t:frame.t};
}
function checkedPart(value,group){
  const states=statesFor(group);
  if(!exact(value,['from','to','t'])||!states.includes(value.from)||!states.includes(value.to)
    ||!finite(value.t)||value.t<0||value.t>1
    ||value.from===value.to&&value.t!==0
    ||value.from!==value.to&&!adjacent(group,value.from,value.to))
    throw new TypeError(`连续表情 ${group} 需要已登记的相邻画稿与 0–1 进度。`);
  return canonical(value);
}
export function validateArticulation(value){
  if(!exact(value,ARTICULATION_GROUPS))throw new TypeError('连续表情必须完整指定眼、嘴和眉五个部位。');
  return Object.fromEntries(ARTICULATION_GROUPS.map(group=>[group,checkedPart(value[group],group)]));
}
export function validateArticulationState(value){
  if(!exact(value,ARTICULATION_GROUPS)||ARTICULATION_GROUPS.some(group=>!statesFor(group).includes(value[group])))
    throw new TypeError('表情目标需要五个已登记的画稿名称。');
  return {...value};
}
export function articulationFromState(value=ARTICULATION_DEFAULT_STATE){
  const state=validateArticulationState(value);
  return Object.fromEntries(ARTICULATION_GROUPS.map(group=>[group,endpoint(state[group])]));
}
/** Compatibility labels only. Render and transmit the fractional articulation
 * itself; these nearest labels do not describe the displayed intermediate. */
export function articulationState(value){
  const checked=validateArticulation(value);
  return Object.fromEntries(ARTICULATION_GROUPS.map(group=>[group,checked[group].t<.5?checked[group].from:checked[group].to]));
}

function nodePath(group,from,to){
  if(from===to)return [from];
  const queue=[[from]],visited=new Set([from]);
  for(let index=0;index<queue.length;index++){
    const path=queue[index],node=path.at(-1);
    for(const [a,b] of edgesFor(group)){
      const next=a===node?b:b===node?a:null;
      if(next===null||visited.has(next))continue;
      const extended=[...path,next];if(next===to)return extended;
      visited.add(next);queue.push(extended);
    }
  }
  throw new Error('已登记表情路径不连通。');
}
const segment=(from,to,start,end)=>({from,to,start,end,length:Math.abs(end-start)});
const segmentPoint=(part,fraction)=>canonical({from:part.from,to:part.to,t:part.start+(part.end-part.start)*fraction});
function ends(point,start){
  if(point.from===point.to)return [{node:point.from,cost:0,segment:null}];
  return [
    {node:point.from,cost:point.t,segment:segment(point.from,point.to,start?point.t:0,start?0:point.t)},
    {node:point.to,cost:1-point.t,segment:segment(point.from,point.to,start?point.t:1,start?1:point.t)},
  ];
}

/** All authored graphs are trees. Their unique shortest path keeps special
 * mouths and conflicting brows going through neutral, including clip samples
 * which span an authored node. It never invents an edge pucker→press. */
function partPath(group,a,b){
  if(a.from===b.from&&a.to===b.to&&a.t===b.t)return [];
  if(a.from!==a.to&&b.from!==b.to&&((a.from===b.from&&a.to===b.to)||(a.from===b.to&&a.to===b.from))){
    const end=a.from===b.from?b.t:1-b.t;
    return Math.abs(end-a.t)<1e-14?[]:[segment(a.from,a.to,a.t,end)];
  }
  let best=null;
  for(const start of ends(a,true))for(const end of ends(b,false)){
    const nodes=nodePath(group,start.node,end.node),length=start.cost+nodes.length-1+end.cost;
    if(best&&length>=best.length)continue;
    const path=[];if(start.segment?.length)path.push(start.segment);
    for(let i=1;i<nodes.length;i++)path.push(segment(nodes[i-1],nodes[i],0,1));
    if(end.segment?.length)path.push(end.segment);
    best={length,path};
  }
  return best.path;
}
function atDistance(path,distance,fallback){
  for(let index=0;index<path.length;index++){
    const part=path[index];
    if(distance<=part.length)return segmentPoint(part,part.length?distance/part.length:1);
    distance-=part.length;
  }
  return {...fallback};
}

/** Timestamp interpolation for recorded DISPLAYED values. No new damping and
 * no nearest-state reset occur at a sample boundary. Same/reversed edges and
 * skipped nodes follow the same authored graph, with exact endpoint recovery. */
export function interpolateArticulation(first,second,amount){
  const a=validateArticulation(first),b=validateArticulation(second);
  if(!finite(amount)||amount<0||amount>1)throw new RangeError('表情插值比例需要 0–1 有限数字。');
  if(amount===0)return a;if(amount===1)return b;
  return Object.fromEntries(ARTICULATION_GROUPS.map(group=>{
    const path=partPath(group,a[group],b[group]),length=path.reduce((sum,part)=>sum+part.length,0);
    return [group,atDistance(path,length*amount,a[group])];
  }));
}

function motionState(current,target,paused=false){
  return Object.freeze({current:Object.freeze(Object.fromEntries(Object.entries(validateArticulation(current))
    .map(([group,value])=>[group,Object.freeze(value)]))),target:Object.freeze(validateArticulationState(target)),paused});
}
function checkMotion(motion){
  if(!exact(motion,['current','target','paused'])||typeof motion.paused!=='boolean')throw new TypeError('连续表情时序状态无效。');
  validateArticulation(motion.current);validateArticulationState(motion.target);
}
export function createArticulationMotion(initial=ARTICULATION_DEFAULT_STATE){
  const checked=validateArticulationState(initial);return motionState(articulationFromState(checked),checked);
}
/** Imported/exported fractional displays stay frozen until a new target is
 * explicitly requested. Restoring does not silently complete an old blink. */
export function restoreArticulationMotion(articulation){
  const checked=validateArticulation(articulation);return motionState(checked,articulationState(checked),true);
}
export function targetArticulationMotion(motion,target){
  checkMotion(motion);return motionState(motion.current,validateArticulationState(target),false);
}
export function freezeArticulationMotion(motion){
  checkMotion(motion);return motionState(motion.current,motion.target,true);
}
function edgeDuration(group,part,timing){
  const forward=part.end>part.start,from=forward?part.from:part.to,to=forward?part.to:part.from;
  if(group.startsWith('eye'))return ARTICULATION_EYES.indexOf(to)>ARTICULATION_EYES.indexOf(from)?timing.eyeClose:timing.eyeOpen;
  if(group==='mouth'){
    if(ARTICULATION_SPECIAL_MOUTHS.includes(from)||ARTICULATION_SPECIAL_MOUTHS.includes(to))return timing.mouthSpecial;
    return ARTICULATION_JAW.indexOf(to)>ARTICULATION_JAW.indexOf(from)?timing.jawOpen:timing.jawClose;
  }
  return timing.brow;
}
function advancePart(group,current,goal,elapsed,timing){
  const target=endpoint(goal),path=partPath(group,current,target);
  let remainingMs=elapsed,remainingDistance=ARTICULATION_MAX_STEP,position={...current};
  for(let index=0;index<path.length;index++){
    const part=path[index];
    const duration=edgeDuration(group,part,timing),distance=Math.min(part.length,remainingDistance,remainingMs/duration);
    if(distance<=0)break;
    position=segmentPoint(part,distance/part.length);
    remainingMs=Math.max(0,remainingMs-distance*duration);remainingDistance=Math.max(0,remainingDistance-distance);
    // A special-mouth / brow branch junction is an actual displayed neutral
    // frame, not a point silently skipped by leftover scheduling time.
    if(index<path.length-1&&!group.startsWith('eye')&&position.from==='neutral'&&position.to==='neutral')break;
    if(distance<part.length-1e-12||remainingMs<=1e-12||remainingDistance<=1e-12)break;
  }
  return position;
}
function proposal(motion){
  return {motion,articulation:validateArticulation(motion.current),state:articulationState(motion.current),
    moving:!motion.paused&&ARTICULATION_GROUPS.some(group=>motion.current[group].from!==motion.target[group]||motion.current[group].to!==motion.target[group])};
}

/** Propose→render→commit. There is no unseen-frame debt or queued old target.
 * Rapid retargets walk from the exact displayed point on the graph, retaining
 * its source pair while reversing within an edge. Frame stalls can slow an
 * action, never skip a whole adjacent painting. Natural total durations are
 * ~144ms closing /192ms opening eyes and ~240ms opening /180ms closing jaw. */
export function advanceArticulationMotion(motion,dtMs,{profile='natural'}={}){
  checkMotion(motion);
  if(!finite(dtMs)||dtMs<0)throw new TypeError('连续表情间隔需要非负有限毫秒数。');
  if(!Object.hasOwn(ARTICULATION_TIMING,profile))throw new RangeError('连续表情节奏只能为自然或快速。');
  if(dtMs===0||motion.paused)return proposal(motion);
  const elapsed=Math.min(ARTICULATION_MAX_FRAME_MS,dtMs),timing=ARTICULATION_TIMING[profile];
  const current=Object.fromEntries(ARTICULATION_GROUPS.map(group=>[group,advancePart(group,motion.current[group],motion.target[group],elapsed,timing)]));
  return proposal(motionState(current,motion.target));
}

/** Manual gaze buttons and sliders share a bounded continuous path. Camera
 * coefficients already have their own filter; recorded frames are exact and
 * must bypass this helper. Like articulation, commit only after drawing. */
export function advanceAuthoredGaze(current,target,dtMs){
  const checked=value=>{
    if(!exact(value,['eyeLeft','eyeRight'])||['eyeLeft','eyeRight'].some(eye=>!exact(value[eye],['x','y'])
      ||['x','y'].some(axis=>!finite(value[eye][axis])||Math.abs(value[eye][axis])>1)))throw new TypeError('视线需要左右眼的有限归一化坐标。');
    return {eyeLeft:{...value.eyeLeft},eyeRight:{...value.eyeRight}};
  };
  const before=checked(current),goal=checked(target);
  if(!finite(dtMs)||dtMs<0)throw new TypeError('视线间隔需要非负有限毫秒数。');
  const elapsed=Math.min(dtMs,ARTICULATION_MAX_FRAME_MS),blend=-Math.expm1(-elapsed/35);
  let moving=false;
  for(const eye of ['eyeLeft','eyeRight'])for(const axis of ['x','y']){
    const delta=goal[eye][axis]-before[eye][axis];
    const step=Math.sign(delta)*Math.min(.25,Math.abs(delta)*blend);
    before[eye][axis]+=step;
    if(elapsed>0&&Math.abs(goal[eye][axis]-before[eye][axis])<.0001)before[eye][axis]=goal[eye][axis];
    moving ||= before[eye][axis]!==goal[eye][axis];
  }
  return {gaze:before,moving};
}

/** Encode the displayed per-eye coordinates in the existing eight channels,
 * clearing opposite signals so clips and OBS reproduce the very same gaze. */
export function authoredGazeChannels(gaze){
  const value=advanceAuthoredGaze(gaze,gaze,0).gaze;
  return {
    eyeLookOutLeft:Math.max(0,value.eyeLeft.x),eyeLookInLeft:Math.max(0,-value.eyeLeft.x),
    eyeLookInRight:Math.max(0,value.eyeRight.x),eyeLookOutRight:Math.max(0,-value.eyeRight.x),
    eyeLookDownLeft:Math.max(0,value.eyeLeft.y),eyeLookUpLeft:Math.max(0,-value.eyeLeft.y),
    eyeLookDownRight:Math.max(0,value.eyeRight.y),eyeLookUpRight:Math.max(0,-value.eyeRight.y),
  };
}
