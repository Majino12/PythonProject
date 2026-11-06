import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSecondarySettings, validateSecondaryFrame, createSecondaryMotion,
  freezeSecondaryMotion, advanceSecondaryMotion,rebaseSecondaryMotion} from './short-hair-secondary-motion.js';

const enabled = {enabled:true, intensity:.6}, front = {yaw:0, pitch:0};

test('secondary motion is opt-in, bounded and normalizes only friendly settings', () => {
  assert.deepEqual(normalizeSecondarySettings(), {enabled:false, intensity:.6});
  assert.deepEqual(normalizeSecondarySettings({enabled:'yes', intensity:3}), {enabled:false, intensity:1});
  const result = advanceSecondaryMotion(createSecondaryMotion(), {yaw:1,pitch:-1}, 16);
  assert.deepEqual(result.secondary, {breath:0,sway:0,hair:0});assert.equal(result.moving, false);
  assert.deepEqual(advanceSecondaryMotion(result.motion, front, 16, {enabled:true,intensity:0}).secondary,
    {breath:0,sway:0,hair:0});
});

test('wire frames reject extra fields, strings, partial and nonfinite channels', () => {
  const valid = {breath:.2,sway:-.3,hair:1};
  const copy = validateSecondaryFrame(valid);valid.breath = 0;assert.equal(copy.breath,.2);
  for (const value of [null,[],{}, {breath:0,sway:0}, {breath:0,sway:0,hair:'0'},
    {breath:0,sway:0,hair:0,enabled:true}, {breath:0,sway:NaN,hair:0},
    {breath:Infinity,sway:0,hair:0}, {breath:0,sway:0,hair:-1.001}]) {
    assert.throws(() => validateSecondaryFrame(value));
  }
});

test('proposal is immutable and a failed renderer can retry the identical frame', () => {
  const committed = createSecondaryMotion();
  const first = advanceSecondaryMotion(committed, front, 16, enabled);
  assert.deepEqual(first, advanceSecondaryMotion(committed, front, 16, enabled));
  assert.deepEqual(committed.current, {breath:0,sway:0,hair:0});
  assert.ok(Object.isFrozen(first.motion));assert.ok(Object.isFrozen(first.motion.current));
  assert.notEqual(first.secondary.breath, 0);
});

test('breathing and a constant head velocity give the same path at 30 and 60 Hz', () => {
  function atRate(rate) {
    let motion = advanceSecondaryMotion(createSecondaryMotion(), front, 1, enabled).motion;
    for (let i=1; i<=rate; i++) motion = advanceSecondaryMotion(motion,
      {yaw:i / rate * .8,pitch:i / rate * -.2}, 1000 / rate, enabled).motion;
    return motion;
  }
  const slow = atRate(30), fast = atRate(60);
  for (const key of ['breath','sway','hair']) assert.ok(Math.abs(slow.current[key] - fast.current[key]) < 1e-12);
  assert.ok(slow.current.hair < 0);
});

test('extreme reversals remain bounded and inertia settles at a stationary pose', () => {
  let motion = createSecondaryMotion();
  for (let i=0; i<600; i++) {
    motion = advanceSecondaryMotion(motion, {yaw:i%2 ? -1:1,pitch:i%3 ? 1:-1}, 1000/60,
      {enabled:true,intensity:1}).motion;
    validateSecondaryFrame(motion.current);assert.ok(Math.abs(motion.hairPosition)<=1);
  }
  for (let i=0; i<600; i++) motion = advanceSecondaryMotion(motion, front, 1000/60, enabled).motion;
  assert.equal(motion.current.hair,0);assert.equal(motion.hairVelocity,0);
});

test('pause preserves the rendered frame, source changes and re-enabling avoid old impulses', () => {
  let motion = advanceSecondaryMotion(createSecondaryMotion(), front, 16, enabled).motion;
  motion = advanceSecondaryMotion(motion, {yaw:1,pitch:0}, 16, enabled).motion;
  const frozen = freezeSecondaryMotion(motion, {yaw:-1,pitch:0});
  assert.deepEqual(frozen.current,motion.current);assert.equal(frozen.elapsed,motion.elapsed);
  assert.equal(frozen.hairVelocity,0);
  assert.strictEqual(advanceSecondaryMotion(frozen, frozen.headPose, 0, enabled).motion, frozen);
  const off = advanceSecondaryMotion(frozen, front, 16).motion;
  const on = advanceSecondaryMotion(off, {yaw:1,pitch:1}, 16, enabled).motion;
  assert.equal(on.current.hair,0);assert.equal(on.hairVelocity,0);
});

test('stalls are bounded, invalid timing and malformed head input cannot reach the renderer', () => {
  const motion = advanceSecondaryMotion(createSecondaryMotion(), front,16,enabled).motion;
  assert.deepEqual(advanceSecondaryMotion(motion,front,100000,enabled),advanceSecondaryMotion(motion,front,100,enabled));
  for (const dt of [-1,NaN,Infinity]) assert.throws(() => advanceSecondaryMotion(motion,front,dt,enabled));
  for (const head of [null,{}, {yaw:2,pitch:0}, {yaw:0,pitch:NaN}]) {
    assert.throws(() => advanceSecondaryMotion(motion,head,16,enabled));
  }
  assert.throws(() => freezeSecondaryMotion({}));
});

test('recorded secondary resumes continuously from its exact displayed frame',()=>{
  const frame={breath:.8,sway:-.7,hair:1},restored=rebaseSecondaryMotion(front,frame);
  assert.deepEqual(restored.current,frame);
  assert.strictEqual(advanceSecondaryMotion(restored,front,0,enabled).motion,restored);
  const first=advanceSecondaryMotion(restored,front,1000/60,enabled);
  for(const key of ['breath','sway','hair'])assert.ok(Math.abs(first.secondary[key]-frame[key])<.05);
  const paused=freezeSecondaryMotion(first.motion);
  assert.equal(paused.rebase.elapsed,first.motion.rebase.elapsed);assert.deepEqual(paused.current,first.motion.current);
  assert.deepEqual(restored.current,frame);
});

test('restored motion is bounded and deterministic at 30 and 60 Hz without inventing a recorded phase',()=>{
  function atRate(rate,frame){
    let motion=rebaseSecondaryMotion(front,frame);
    for(let i=0;i<rate*2;i++){
      motion=advanceSecondaryMotion(motion,front,1000/rate,{enabled:true,intensity:1}).motion;
      validateSecondaryFrame(motion.current);
    }
    return motion;
  }
  for(const frame of [{breath:1,sway:1,hair:1},{breath:-1,sway:-1,hair:-1},{breath:.7,sway:-.3,hair:.4}]){
    const slow=atRate(30,frame),fast=atRate(60,frame);
    for(const key of ['breath','sway','hair'])assert.ok(Math.abs(slow.current[key]-fast.current[key])<1e-12);
  }
  let motion=rebaseSecondaryMotion(front,{breath:1,sway:-1,hair:.5});
  for(let i=0;i<600;i++)motion=advanceSecondaryMotion(motion,front,1000/60,enabled).motion;
  assert.equal(motion.rebase,null);assert.equal(motion.current.hair,0);
  assert.throws(()=>rebaseSecondaryMotion(front,{breath:0,sway:0,hair:2}));
});
