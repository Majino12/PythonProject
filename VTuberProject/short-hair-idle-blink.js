/** Optional blink timing; actual eyelids still use the five authored paintings.
 * No clocks/random globals: a draw can propose and retry without advancing state. */
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const random=seed=>{const next=(Math.imul(seed,1664525)+1013904223)>>>0;return{seed:next,value:next/4294967296};};
export function createIdleBlink(seed=1327){
  const next=random(Number.isInteger(seed)?seed>>>0:1327);
  return Object.freeze({phase:'waiting',elapsed:0,delayMs:2800+next.value*2400,seed:next.seed,closure:0});
}
export function advanceIdleBlink(motion,dtMs){
  if(!motion||!['waiting','closing','closed','opening'].includes(motion.phase)||!Number.isFinite(dtMs)||dtMs<0)throw new Error('待机眨眼时序无效。');
  let {phase,elapsed,delayMs,seed}=motion;elapsed+=clamp(dtMs,0,100);
  const duration=()=>phase==='waiting'?delayMs:phase==='closing'?120:phase==='closed'?100:160;
  while(elapsed>=duration()){
    elapsed-=duration();
    if(phase==='waiting')phase='closing';else if(phase==='closing')phase='closed';else if(phase==='closed')phase='opening';
    else{phase='waiting';const next=random(seed);seed=next.seed;delayMs=2800+next.value*2400;}
  }
  const smooth=value=>value*value*(3-2*value);
  const closure=phase==='waiting'?0:phase==='closed'?1:phase==='closing'?smooth(elapsed/120):1-smooth(elapsed/160);
  const next=Object.freeze({phase,elapsed,delayMs,seed,closure});return {motion:next,closure};
}
export function applyIdleBlink(channels,closure){
  const value=Number.isFinite(closure)?clamp(closure,0,1):0;
  return {...channels,eyeBlinkLeft:Math.max(channels.eyeBlinkLeft||0,value),eyeBlinkRight:Math.max(channels.eyeBlinkRight||0,value)};
}
