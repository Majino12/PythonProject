// Fixed registration of independently painted drawings. No tracking-driven warp.
import { LUNA_EYE_ART } from "./painted-luna-eye-art.js";
import { LUNA_MOUTH_ART, LUNA_BROW_ART } from "./painted-luna-mouth-art.js";
const v1 = "./assets/luna-painted-v1/";
const root = "./assets/luna-painted-v2/";
const eyeKeys = ["open","blink10","blink20","blink30","blink40","half","blink60","blink70","blink80","blink90","closed","happyClosed"];
function eyeFrames(rects) {
  const f=Object.fromEntries(eyeKeys.map((k,i)=>[k,rects[i]]));
  return {...f,quarter:f.blink20,threeQuarter:f.blink70};
}
function oppositeMouth(frames) {
 const opposite={...frames};
 for(const s of ["Soft","Mid",""]){opposite["puckerLeft"+s]=frames["puckerRight"+s];opposite["puckerRight"+s]=frames["puckerLeft"+s];}
 return opposite;
}
const layer=(atlas,dest,flipX=false,clip=null)=>({atlas,dest,flipX,clip});
const hidden={visible:false,clip:null};
const expressionRoot="./assets/luna-painted-v4/";
function mouth(atlas,cx,baseline,width,flipX=false,clip=null){
 const art=LUNA_MOUTH_ART[atlas.replace(/Left$/,"")],scale=width/art.neutralInkWidth;
 return layer(atlas,[cx-90*scale,baseline-64*scale,180*scale,180*scale],flipX,clip);
}
function brow(rect,flipX=false,clip=null){
 const scale=rect[2]/LUNA_BROW_ART.neutralInkWidth;
 return layer("brows",[rect[0]+rect[2]/2-180*scale,rect[1]+rect[3]/2-81*scale,360*scale,180*scale],flipX,clip);
}
// Registration is measured against the WHITE opening, not transparent crop
// padding. Scale is uniform and constant per pose, never a blink/pose warp.
function eye(atlas,cx,cy,whiteWidth,flipX=false,clip=null,pitch=0){
 const art=LUNA_EYE_ART[atlas], [sx,sy,sw,sh]=art.rects[0];
 const [x0,y0,x1,y1]=art.white, scale=whiteWidth/(x1-x0);
 const anchorX=(x0+x1)/2-sx, anchorY=(y0+y1)/2-sy;
 return {...layer(atlas,[cx-(flipX?sw-anchorX:anchorX)*scale,cy-anchorY*scale,sw*scale,sh*scale],flipX,clip),gazeBias:[0,pitch*.2]};
}
function socket(atlas){
 const art=LUNA_EYE_ART[atlas], [sx,sy,sw,sh]=art.rects[0];
 const [x0,y0,x1,y1]=art.white;
 // The upper lid slightly covers the iris at rest (no surprised floating dot).
 // Horizontal sclera stays visible; looking down reveals the upper white.
 const h=(y1-y0)*(atlas==="sideNear"||atlas==="sideFar"?1.20:atlas==="profileEyes"?1.08:1.12);
 const w=h*art.irisRect[2]/art.irisRect[3];
 return {src:"./assets/luna-painted-v3/"+art.file,frames:eyeFrames(art.rects),gaze:{
  src:"./assets/luna-painted-v3/iris.png",rect:art.irisRect,
  iris:[((x0+x1-w)/2-sx)/sw,((y0+y1-h)/2-sy-(y1-y0)*.08)/sh,w/sw,h/sh],
  range:[(x1-x0)*.14/sw,(y1-y0)*.20/sh],
  apertures:eyeFrames(art.apertures),
 }};
}
const shrink=(rect,factor)=>[rect[0]+rect[2]*(1-factor)/2,rect[1]+rect[3]*(1-factor)/2,rect[2]*factor,rect[3]*factor];
const frontLayers={
 leftEye:eye("eyes",627,448,94),rightEye:eye("eyes",417,448,94,true),
 leftBrow:brow([573,363,104,42],true),
 rightBrow:brow([365,363,104,42],false,[[330,414],[366,399],[398,370],[425,321],[416,374],[398,412],[445,407],[474,394],[497,370],[500,435],[330,435]]),
 mouth:mouth("mouth",523,580,76),
};
// Centers follow each independently painted head. The near eye remains on
// the broader cheek; positive yaw is nose toward VIEWER RIGHT (not ARKit R).
const eyeRegistration={
 right20:[[588,438,84],[728,435,62]],left20:[[512,435,84],[358,432,62]],
 right40:[[633,432,77],[772,426,44]],left40:[[496,430,77],[332,423,44]],
 right65:[[722,410,60],[0,0,1]],left65:[[365,408,60],[0,0,1]],
 "right40-up":[[609,357,77],[748,338,44]],"left40-up":[[499,346,77],[348,338,44]],
 "right40-down":[[625,517,75],[758,505,43]],"left40-down":[[487,490,75],[323,480,43]],
};
// The base drawings carry yaw/pitch but no head roll. Register both white
// openings on one eye axis; do not let independent atlas padding create a
// tilted eye pair (the old right-up registration differed by 19 source px).
const eyeAxis={right20:437,left20:434,right40:429,left40:426,
 "right40-up":357,"left40-up":346,"right40-down":512,"left40-down":486};
const browOnAxis=(rect,delta)=>[rect[0],rect[1]+delta,rect[2],rect[3]];
function turned(id,yaw,pitch,mouthRect,browNear,browFar,clip,profile=false){
 const [mx,my,mw]=mouthRect;
 const right=yaw>0,ne=right?"rightEye":"leftEye",fe=right?"leftEye":"rightEye",nb=right?"rightBrow":"leftBrow",fb=right?"leftBrow":"rightBrow";
 const [nearEye,farEye]=eyeRegistration[id];
 const axis=eyeAxis[id],near=axis===undefined?nearEye:[nearEye[0],axis,nearEye[2]],far=axis===undefined?farEye:[farEye[0],axis,farEye[2]];
 const lowerLip= id==="right40-up"||id==="left40-up" ? 22 : 0;
 return {id,yaw,pitch,base:root+id+".png",layers:{
  // Near/profile/down-side sources are anatomical RIGHT (tear duct RIGHT).
  // Far source is anatomical LEFT (tear duct LEFT). No baked-in iris to flip.
  [ne]:eye(profile?"profileEyes":pitch<0?"sideDown":"sideNear",...near,!right,clip,pitch),
  // On left diagonal views the long fringe completely occludes the far eye.
  [fe]:profile||id==="left40-up"||id==="left40-down"?hidden:eye(pitch<0?"downEyes":"sideFar",...far,!right,clip,pitch),
  [nb]:brow(shrink(browOnAxis(browNear,near[1]-nearEye[1]),.80),!right,clip),[fb]:profile||id==="left40-up"||id==="left40-down"?hidden:brow(shrink(browOnAxis(browFar,far[1]-farEye[1]),.80),right,clip),
  mouth:mouth((profile?"profileMouth":"sideMouth")+(right?"":"Left"),mx+mw/2,my+mw*228/240/2-3+lowerLip,profile?43:Math.abs(yaw)<.5?68:60,!right,clip),
 }};
}
export const LUNA_PAINTED_MANIFEST={
 version:1,width:1024,height:1536,base:v1+"base.png",
 sequences:{eyes:eyeKeys.slice(0,11),jaw:["closed","jaw10","jaw25","jaw45","jaw65","openWide"],pucker:["puckerSoft","puckerMid","pucker"],press:["pressSoft","pressMid","press"],puckerLeft:["puckerLeftSoft","puckerLeftMid","puckerLeft"],puckerRight:["puckerRightSoft","puckerRightMid","puckerRight"],funnel:["funnelSoft","funnel"],browUp:["neutral","upSoft","upMid","up"],browDown:["neutral","downSoft","downMid","down"],browWorried:["neutral","worriedSoft","worriedMid","worried"],browOuterUp:["neutral","outerUpSoft","outerUpMid","outerUp"]},
 atlases:{
  eyes:socket("eyes"),sideNear:socket("sideNear"),sideFar:socket("sideFar"),
  profileEyes:socket("profileEyes"),downEyes:socket("downEyes"),sideDown:socket("sideDown"),
  ...Object.fromEntries(Object.entries(LUNA_MOUTH_ART).map(([name,art])=>[name,{src:expressionRoot+art.file,frames:art.frames}])),
  sideMouthLeft:{src:expressionRoot+LUNA_MOUTH_ART.sideMouth.file,frames:oppositeMouth(LUNA_MOUTH_ART.sideMouth.frames)},
  profileMouthLeft:{src:expressionRoot+LUNA_MOUTH_ART.profileMouth.file,frames:oppositeMouth(LUNA_MOUTH_ART.profileMouth.frames)},
  brows:{src:expressionRoot+LUNA_BROW_ART.file,frames:LUNA_BROW_ART.frames},
 },
 layers:frontLayers,
 poses:[
  {id:"front",yaw:0,pitch:0,base:v1+"base.png"},
  turned("right20",.33,0,[639,517,96,84],[521,361,128,48],[706,360,60,40],[[465,420],[565,400],[630,353],[671,276],[731,330],[781,402],[750,551],[633,655],[522,594]]),
  turned("left20",-.33,0,[363,502,96,84],[456,355,128,48],[320,357,60,40],[[306,415],[379,402],[421,331],[478,227],[548,300],[615,358],[592,518],[462,633],[350,542]]),
  turned("right40",.66,0,[687,508,88,77],[568,358,124,46],[754,360,44,38],[[495,415],[586,401],[665,355],[700,280],[775,350],[817,424],[796,524],[669,644],[550,590]]),
  turned("left40",-.66,0,[328,500,88,77],[440,350,124,46],[305,356,44,38],[[291,412],[342,386],[376,320],[430,226],[533,316],[605,369],[577,507],[419,630],[325,535]]),
  turned("right65",1,0,[753,489,62,64],[663,345,118,44],[0,0,1,1],[[592,385],[687,370],[747,348],[797,324],[824,422],[831,459],[794,510],[750,635],[651,610],[602,549]],true),
  turned("left65",-1,0,[271,489,62,64],[309,343,118,44],[0,0,1,1],[[297,393],[342,347],[382,275],[434,236],[501,326],[501,436],[450,536],[341,624],[303,549],[281,509],[254,457]],true),
  {id:"up",yaw:0,pitch:1,base:root+"up.png",layers:{
   leftEye:eye("eyes",624,356,88,false,null,1),rightEye:eye("eyes",419,356,88,true,null,1),
   leftBrow:brow(shrink([563,278,132,49],.80),true),rightBrow:brow(shrink([341,278,132,49],.80),false,[[345,322],[416,280],[468,232],[490,330],[345,350]]),mouth:mouth("mouth",523,449,70),
  }},
  {id:"down",yaw:0,pitch:-1,base:root+"down.png",layers:{
   leftEye:eye("downEyes",622,527,86,false,[[553,529],[607,446],[661,472],[700,486],[697,572],[552,580]],-1),
   rightEye:eye("downEyes",440,531,86,true,[[356,506],[406,503],[428,490],[457,530],[507,513],[507,585],[363,580]],-1),
   leftBrow:brow(shrink([563,455,128,48],.80),true),rightBrow:hidden,mouth:mouth("mouth",526,635,70),
  }},
  turned("right40-up",.66,1,[672,406,88,77],[544,266,124,46],[729,257,44,38],[[471,350],[553,311],[623,256],[668,180],[733,242],[775,337],[790,435],[736,580],[601,557],[503,492]]),
  turned("left40-up",-.66,1,[318,408,88,77],[444,255,124,46],[320,258,44,38],[[326,335],[383,300],[441,247],[481,174],[551,247],[632,321],[604,442],[496,549],[355,579],[309,450]]),
  turned("right40-down",.66,-1,[655,572,88,77],[562,426,124,46],[737,426,44,38],[[498,468],[573,448],[630,467],[695,434],[740,353],[793,373],[788,486],[738,599],[625,701],[526,617]]),
  turned("left40-down",-.66,-1,[327,545,88,77],[430,397,124,46],[295,398,44,38],[[289,465],[351,457],[396,403],[432,312],[488,347],[561,399],[553,512],[476,604],[430,665],[359,615],[304,538]]),
 ],
};
const [mouthX,mouthY,mouthW,mouthH]=frontLayers.mouth.dest;
export const LUNA_PAINTED_RIG={face:{x:520,y:459,w:390,h:440},leftEye:{x:627,y:448,w:126,h:67},rightEye:{x:417,y:448,w:126,h:67},mouth:{x:mouthX+mouthW/2,y:mouthY+mouthH/2,w:mouthW,h:mouthH},skin:"#fce5d5",patchesEnabled:true};
