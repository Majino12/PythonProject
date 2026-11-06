import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS,sanitizeChannels} from './expression-model.js';
import {DEFAULT_PERFORMANCE_PRESETS,createPerformancePreset,validatePerformancePreset,validatePerformancePresets,
  createPerformanceMixer,freezePerformanceMixer,setPerformancePreset,clearPerformancePresets,isPerformancePresetActive,proposePerformanceFrame,matchPerformanceShortcut} from './short-hair-performance.js';
const preset=(id,groups,channels)=>createPerformancePreset({id,name:id,groups,channels});
const sample=(mixer,base,ms=300)=>proposePerformanceFrame(mixer,base,ms);

test('four built-in performance presets use existing complete channels, explicit groups, unique ids and immutable copies',()=>{
  assert.equal(DEFAULT_PERFORMANCE_PRESETS.length,4);assert.equal(validatePerformancePresets(DEFAULT_PERFORMANCE_PRESETS).length,4);
  for(const value of DEFAULT_PERFORMANCE_PRESETS){assert.ok(Object.isFrozen(value));assert.ok(Object.isFrozen(value.channels));assert.equal(Object.keys(value.channels).length,22);}
  const parsed=validatePerformancePresets(DEFAULT_PERFORMANCE_PRESETS);parsed[0].channels.eyeBlinkLeft=0;parsed[0].groups.push('mouth');
  assert.equal(DEFAULT_PERFORMANCE_PRESETS[0].channels.eyeBlinkLeft,.5);assert.deepEqual(DEFAULT_PERFORMANCE_PRESETS[0].groups,['eyes']);
});

test('performance imports reject partial, unknown, duplicate, oversized and nonnumeric state before changing anything',()=>{
  const valid=preset('one',['eyes'],{eyeBlinkLeft:.5});
  for(const invalid of [null,[],{}, {...valid,id:''},{...valid,name:'  '},{...valid,name:' x '},{...valid,name:'x'.repeat(41)},
    {...valid,groups:[]},{...valid,groups:['eyes','eyes']},{...valid,groups:['hair']},{...valid,extra:1},
    {...valid,channels:{eyeBlinkLeft:1}},{...valid,channels:{...valid.channels,unknown:0}},
    ...[NaN,Infinity,-.01,1.01,'0',null].map(value=>({...valid,channels:{...valid.channels,jawOpen:value}}))])
    assert.throws(()=>validatePerformancePreset(invalid));
  for(const invalid of [null,{},[valid,valid],Array.from({length:9},(_,i)=>({...valid,id:String(i)}))])assert.throws(()=>validatePerformancePresets(invalid));
  assert.deepEqual(validatePerformancePresets([]),[]);assert.equal(validatePerformancePresets(Array.from({length:8},(_,i)=>({...valid,id:String(i)}))).length,8);
  assert.equal(createPerformancePreset({...valid,name:'  我的表情  ',channels:{eyeBlinkLeft:5}}).name,'我的表情');
  assert.equal(createPerformancePreset({...valid,channels:{eyeBlinkLeft:5}}).channels.eyeBlinkLeft,1);
});

test('performance proposal masks selected groups, leaves live base unchanged, and commits only when caller assigns the returned state',()=>{
  const base=Object.freeze(sanitizeChannels({jawOpen:.8,browInnerUp:.2,eyeBlinkRight:.3,eyeLookOutLeft:.7}));
  const active=setPerformancePreset(createPerformanceMixer(),preset('eyes',['eyes'],{eyeBlinkLeft:1,eyeBlinkRight:1}));
  const first=sample(active,base,150),retry=sample(active,base,150);
  assert.deepEqual(retry,first);assert.equal(active.entries[0].weight,0);assert.equal(first.mixer.entries[0].weight,.5);
  assert.equal(first.effectiveCoefficients.eyeBlinkLeft,.5);assert.ok(Math.abs(first.effectiveCoefficients.eyeBlinkRight-.65)<1e-12);
  for(const {key,group} of CHANNELS)if(group!=='eyes')assert.equal(first.effectiveCoefficients[key],base[key]);
  assert.equal(base.eyeBlinkLeft,0);assert.equal(first.moving,true);assert.deepEqual(first.activeIds,['eyes']);
  const final=sample(first.mixer,base,150);assert.equal(final.effectiveCoefficients.eyeBlinkLeft,1);assert.equal(final.moving,false);
  assert.ok(Object.isFrozen(final.mixer));assert.ok(Object.isFrozen(final.mixer.entries));
});

test('latest activation has group priority, releasing it reveals previous expression and clearing returns to the changing live source',()=>{
  const half=preset('half',['eyes'],{eyeBlinkLeft:.5,eyeBlinkRight:.5}),wink=preset('wink',['eyes'],{eyeBlinkLeft:1});
  const mouth=preset('mouth',['mouth'],{mouthPucker:1});
  let mixer=sample(setPerformancePreset(createPerformanceMixer(),half),{}).mixer;
  mixer=sample(setPerformancePreset(mixer,mouth),{}).mixer;
  mixer=sample(setPerformancePreset(mixer,wink),{}).mixer;
  let shown=sample(mixer,{jawOpen:.2});assert.equal(shown.effectiveCoefficients.eyeBlinkLeft,1);assert.equal(shown.effectiveCoefficients.eyeBlinkRight,0);assert.equal(shown.effectiveCoefficients.mouthPucker,1);
  mixer=setPerformancePreset(mixer,wink,false);assert.equal(isPerformancePresetActive(mixer,'wink'),false);
  shown=sample(mixer,{},150);assert.ok(shown.effectiveCoefficients.eyeBlinkLeft>.5&&shown.effectiveCoefficients.eyeBlinkLeft<1);
  mixer=sample(shown.mixer,{},150).mixer;shown=sample(mixer,{});assert.equal(shown.effectiveCoefficients.eyeBlinkLeft,.5);
  const cleared=clearPerformancePresets(mixer);assert.equal(cleared.entries.length,2);
  shown=sample(cleared,{jawOpen:.9,eyeBlinkLeft:.1,eyeBlinkRight:.8});
  assert.deepEqual(shown.effectiveCoefficients,sanitizeChannels({jawOpen:.9,eyeBlinkLeft:.1,eyeBlinkRight:.8}));assert.equal(shown.mixer.entries.length,0);assert.equal(shown.moving,false);
});

test('reversing a fade preserves its current weight and moving a reactivated expression to top is deterministic',()=>{
  const a=preset('a',['eyes'],{eyeBlinkLeft:1}),b=preset('b',['eyes'],{eyeBlinkLeft:.2});
  let mixer=sample(setPerformancePreset(createPerformanceMixer(),a),{},120).mixer;
  mixer=setPerformancePreset(mixer,a,false);const reversed=sample(mixer,{},60);assert.ok(Math.abs(reversed.mixer.entries[0].weight-.2)<1e-12);
  mixer=setPerformancePreset(reversed.mixer,a,true);assert.equal(mixer.entries[0].weight,reversed.mixer.entries[0].weight);
  mixer=sample(mixer,{}).mixer;mixer=sample(setPerformancePreset(mixer,b),{}).mixer;
  mixer=setPerformancePreset(mixer,a,false);mixer=setPerformancePreset(mixer,a,true);assert.equal(mixer.entries.at(-1).preset.id,'a');
  assert.equal(sample(mixer,{}).effectiveCoefficients.eyeBlinkLeft,1);
});

test('performance timing is independent of frame count, rejects invalid time, and stays bounded under repeated group overlaps',()=>{
  let active=setPerformancePreset(createPerformanceMixer(),preset('full',['eyes','mouth','brows','gaze'],Object.fromEntries(CHANNELS.map(({key})=>[key,1]))));
  for(const time of [-1,NaN,Infinity,'16'])assert.throws(()=>sample(active,{},time));
  const one=sample(active,{},300);for(let i=0;i<30;i++)active=sample(active,{},10).mixer;
  assert.deepEqual(sample(active,{}).effectiveCoefficients,one.effectiveCoefficients);
  let mixer=createPerformanceMixer();
  for(let i=0;i<8;i++)mixer=setPerformancePreset(mixer,preset(String(i),['eyes','mouth'],{eyeBlinkLeft:i/7,mouthPucker:1-i/7}));
  assert.throws(()=>setPerformancePreset(mixer,preset('ninth',['eyes'],{})));
  const result=sample(mixer,{jawOpen:.7},119);for(const value of Object.values(result.effectiveCoefficients))assert.ok(value>=0&&value<=1);
});

test('page shortcuts match 1–8 and Escape while respecting all text-input, focus and browser shortcut boundaries',()=>{
  for(let i=1;i<=8;i++)for(const event of [{key:String(i)},{code:`Digit${i}`},{code:`Numpad${i}`}])assert.equal(matchPerformanceShortcut(event),i-1);
  assert.equal(matchPerformanceShortcut({key:'Escape'}),'clear');assert.equal(matchPerformanceShortcut({code:'Escape'}),'clear');
  for(const event of [{key:'0'},{key:'9'},{key:'a'},...['ctrlKey','metaKey','altKey','shiftKey','repeat','isComposing','defaultPrevented'].map(key=>({key:'1',[key]:true})),
    ...['INPUT','TEXTAREA','SELECT'].map(tagName=>({key:'1',target:{tagName}})),{key:'1',target:{isContentEditable:true}},
    {key:'1',target:{closest:()=>({})}}])assert.equal(matchPerformanceShortcut(event),null);
  for(const options of [{hidden:true},{editable:true},{focused:false}])assert.equal(matchPerformanceShortcut({key:'Escape'},options),null);
  assert.equal(matchPerformanceShortcut(null),null);assert.equal(matchPerformanceShortcut({key:'1',target:{tagName:'BUTTON'}}),0);
});

test('freezing a partly faded expression preserves weights, targets and active intent without a running animation',()=>{
  const a=preset('a',['eyes'],{eyeBlinkLeft:1});
  const partly=sample(setPerformancePreset(createPerformanceMixer(),a),{},120),frozen=freezePerformanceMixer(partly.mixer);
  const held=sample(frozen,{},100000);
  assert.equal(frozen.paused,true);assert.equal(held.mixer.paused,true);assert.equal(held.moving,false);
  assert.equal(held.mixer.entries[0].weight,partly.mixer.entries[0].weight);assert.equal(held.mixer.entries[0].target,1);
  assert.deepEqual(held.activeIds,['a']);assert.deepEqual(held.effectiveCoefficients,partly.effectiveCoefficients);
  assert.equal(isPerformancePresetActive(held.mixer,'a'),true);assert.equal(partly.mixer.paused,false);
});

test('new activation and clear commands unpause from the last shown weights and failed redraw proposals remain repeatable',()=>{
  const a=preset('a',['eyes'],{eyeBlinkLeft:1}),b=preset('b',['mouth'],{mouthPucker:1});
  const frozen=freezePerformanceMixer(sample(setPerformancePreset(createPerformanceMixer(),a),{},120).mixer);
  const resumed=setPerformancePreset(frozen,b);assert.equal(resumed.paused,false);assert.equal(resumed.entries[0].weight,frozen.entries[0].weight);
  const proposal=sample(resumed,{},60);assert.deepEqual(sample(resumed,{},60),proposal);assert.equal(resumed.entries[0].weight,.4);
  assert.ok(proposal.mixer.entries[0].weight>resumed.entries[0].weight);
  const clear=clearPerformancePresets(frozen);assert.equal(clear.paused,false);assert.equal(clear.entries[0].weight,.4);assert.equal(clear.entries[0].target,0);
  const fadeOut=sample(clear,{},60);assert.ok(fadeOut.mixer.entries[0].weight<.4);assert.deepEqual(fadeOut.activeIds,[]);assert.equal(fadeOut.moving,true);
  const same=setPerformancePreset(frozen,a,true);assert.equal(same.paused,false);assert.equal(same.entries[0].weight,.4);
});

test('mixer accepts a pre-pause state with no paused field and rejects malformed pause flags',()=>{
  const old={serial:0,entries:[]};assert.equal(sample(old,{}).mixer.paused,false);
  for(const paused of [0,1,'true',null,undefined])assert.throws(()=>sample({...old,paused},{}));
  assert.equal(createPerformanceMixer().paused,false);
});

test('eight active slots can be replaced while up to eight previous layers retire, with a bounded total and a working clear-all',()=>{
  let mixer=createPerformanceMixer();const presets=Array.from({length:8},(_,i)=>preset(`old-${i}`,['eyes'],{eyeBlinkLeft:i/7}));
  for(const value of presets)mixer=setPerformancePreset(mixer,value,true);mixer=sample(mixer,{}).mixer;
  for(const [index,value] of presets.entries()){
    mixer=setPerformancePreset(mixer,value,false);mixer=setPerformancePreset(mixer,preset(`new-${index}`,['mouth'],{jawOpen:index/7}),true);
  }
  assert.equal(mixer.entries.length,16);assert.equal(mixer.entries.filter(entry=>entry.target===1).length,8);
  assert.throws(()=>setPerformancePreset(mixer,preset('extra',['brows'],{})),/淡出|最多/);
  const cleared=sample(clearPerformancePresets(mixer),{});assert.equal(cleared.mixer.entries.length,0);assert.equal(cleared.moving,false);
  const retired=sample(mixer,{});assert.equal(retired.mixer.entries.length,8);assert.equal(retired.activeIds.every(id=>id.startsWith('new-')),true);
});

test('rapid reactivation of a covered gaze preset starts at the shown mixture and fades priority without freezing live input',()=>{
  const left=preset('left',['gaze'],{eyeLookInLeft:1,eyeLookOutRight:1}),right=preset('right',['gaze'],{eyeLookOutLeft:1,eyeLookInRight:1});
  let mixer=sample(setPerformancePreset(createPerformanceMixer(),left),{},150).mixer;
  mixer=sample(setPerformancePreset(mixer,right),{},100).mixer;
  mixer=setPerformancePreset(mixer,left,false);const shown=sample(mixer,{eyeLookOutLeft:.1},0);
  const restarted=setPerformancePreset(mixer,left,true),first=sample(restarted,{eyeLookOutLeft:.1},0);
  assert.ok(first.mixer.handoff);assert.equal(first.moving,true);
  for(const key of Object.keys(shown.effectiveCoefficients))assert.ok(Math.abs(first.effectiveCoefficients[key]-shown.effectiveCoefficients[key])<1e-12,key);
  const liveBase={eyeLookOutLeft:.9},oldOnNewBase=sample(mixer,liveBase,0),newOnNewBase=sample(restarted,liveBase,0);
  assert.ok(newOnNewBase.effectiveCoefficients.eyeLookOutLeft>first.effectiveCoefficients.eyeLookOutLeft);
  assert.ok(Math.abs(newOnNewBase.effectiveCoefficients.eyeLookOutLeft-oldOnNewBase.effectiveCoefficients.eyeLookOutLeft)<1e-12);
  const middle=sample(restarted,liveBase,150),settled=sample(middle.mixer,liveBase,150);
  assert.equal(settled.mixer.handoff,null);assert.equal(settled.effectiveCoefficients.eyeLookInLeft,1);assert.equal(settled.effectiveCoefficients.eyeLookOutLeft,0);
  const frozen=freezePerformanceMixer(middle.mixer),held=sample(frozen,liveBase,500);
  assert.deepEqual(held.effectiveCoefficients,middle.effectiveCoefficients);assert.equal(held.moving,false);assert.equal(held.mixer.handoff.elapsedMs,middle.mixer.handoff.elapsedMs);
});

test('repeated interrupted priority handoffs remain bounded and nonrecursive and proposals stay transactional',()=>{
  const values=[preset('left',['gaze'],{eyeLookInLeft:1}),preset('right',['gaze'],{eyeLookOutLeft:1})];
  let mixer=createPerformanceMixer();for(const value of values)mixer=sample(setPerformancePreset(mixer,value,true),{}).mixer;
  for(let i=0;i<100;i++){
    const value=values[i%2];mixer=setPerformancePreset(mixer,value,false);
    const before=sample(mixer,{eyeLookInLeft:.35},0);mixer=setPerformancePreset(mixer,value,true);
    const atSwitch=sample(mixer,{eyeLookInLeft:.35},0);
    for(const key of Object.keys(before.effectiveCoefficients))assert.ok(Math.abs(before.effectiveCoefficients[key]-atSwitch.effectiveCoefficients[key])<1e-12);
    const proposal=sample(mixer,{eyeLookInLeft:.35},17);assert.deepEqual(sample(mixer,{eyeLookInLeft:.35},17),proposal);
    assert.equal(mixer.entries.length,2);assert.ok(JSON.stringify(mixer).length<3000);
    for(const coefficient of Object.values(proposal.effectiveCoefficients))assert.ok(coefficient>=0&&coefficient<=1);
    mixer=proposal.mixer;
  }
  const cleared=sample(clearPerformancePresets(mixer),{},300);assert.deepEqual(cleared.effectiveCoefficients,sanitizeChannels());assert.equal(cleared.moving,false);
});
