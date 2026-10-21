// Fixed registration of independently painted drawings. No tracking-driven warp.
const v1 = "./assets/luna-painted-v1/";
const root = "./assets/luna-painted-v2/";
const eyeKeys = ["open","blink10","blink20","blink30","blink40","half","blink60","blink70","blink80","blink90","closed","happyClosed"];
const mouthKeys = ["closed","jaw10","jaw25","jaw45","jaw65","openWide","puckerSoft","puckerMid","pucker","pressSoft","pressMid","press","puckerLeftSoft","puckerLeftMid","puckerLeft","puckerRightSoft","puckerRightMid","puckerRight","smileClosed","smileOpen","frownClosed","frownOpen","funnelSoft","funnel"];
function eyeFrames(rects) {
  const f=Object.fromEntries(eyeKeys.map((k,i)=>[k,rects[i]]));
  return {...f,quarter:f.blink20,threeQuarter:f.blink70};
}
function mouthFrames(rects) {
  const f=Object.fromEntries(mouthKeys.map((k,i)=>[k,rects[i]]));
  return {...f,openSmall:f.jaw10,openMedium:f.jaw45,side:f.puckerLeftSoft};
}
const frontEyes=eyeFrames([
 [3,139,340,240],[369,140,340,240],[725,142,340,240],[1085,141,340,240],
 [3,484,340,240],[371,480,340,240],[735,485,340,240],[1096,485,340,240],
 [19,799,340,240],[380,799,340,240],[747,799,340,240],[1107,781,340,240],
]);
const frontMouth=mouthFrames([
 [2,63,256,224],[260,65,256,224],[516,68,256,224],[775,56,256,224],[1029,45,256,224],[1277,42,256,224],
 [1,297,256,224],[258,299,256,224],[508,300,256,224],[774,302,256,224],[1028,302,256,224],[1278,300,256,224],
 [6,530,256,224],[256,526,256,224],[521,546,256,224],[756,532,256,224],[1047,546,256,224],[521,546,256,224],
 [6,756,256,224],[258,748,256,224],[519,780,256,224],[772,784,256,224],[1030,770,256,224],[1280,764,256,224],
]);
const sideNear=eyeFrames([
 [8,157,252,200],[370,156,252,200],[730,157,252,200],[1091,155,252,200],
 [8,475,252,200],[370,473,252,200],[729,473,252,200],[1091,475,252,200],
 [8,791,252,200],[369,790,252,200],[729,792,252,200],[1086,774,252,200],
]);
const sideFar=eyeFrames([
 [260,194,106,156],[621,193,106,156],[982,191,106,156],[1341,189,106,156],
 [258,512,106,156],[622,510,106,156],[982,509,106,156],[1340,508,106,156],
 [250,825,106,156],[612,823,106,156],[975,821,106,156],[1337,812,106,156],
]);
const profileEyes=eyeFrames([
 [5,139,352,232],[367,135,352,232],[729,137,352,232],[1091,135,352,232],
 [5,473,352,232],[367,471,352,232],[729,468,352,232],[1091,467,352,232],
 [5,792,352,232],[367,791,352,232],[729,784,352,232],[1091,786,352,232],
]);
const sideMouth=mouthFrames([
 [8,71,240,228],[264,70,240,228],[520,68,240,228],[776,63,240,228],[1032,51,240,228],[1288,42,240,228],
 [8,300,240,228],[264,302,240,228],[520,300,240,228],[776,304,240,228],[1032,304,240,228],[1288,304,240,228],
 [8,524,240,228],[264,522,240,228],[520,525,240,228],[776,520,240,228],[1032,544,240,228],[520,525,240,228],
 [8,736,240,228],[264,721,240,228],[520,767,240,228],[776,762,240,228],[1032,752,240,228],[1288,744,240,228],
]);
sideMouth.puckerRight=sideMouth.puckerLeft;
const profileMouth=mouthFrames([
 [8,63,240,228],[264,63,240,228],[520,63,240,228],[776,55,240,228],[1032,52,240,228],[1288,50,240,228],
 [8,293,240,228],[264,293,240,228],[520,293,240,228],[776,294,240,228],[1032,294,240,228],[1288,297,240,228],
 [8,516,240,228],[264,516,240,228],[520,518,240,228],[776,498,240,228],[1032,541,240,228],[520,518,240,228],
 [8,742,240,228],[264,722,240,228],[520,762,240,228],[776,764,240,228],[1032,753,240,228],[1288,753,240,228],
]);
profileMouth.puckerRight=profileMouth.puckerLeft;
function oppositeMouth(frames) {
 const opposite={...frames};
 for(const s of ["Soft","Mid",""]){opposite["puckerLeft"+s]=frames["puckerRight"+s];opposite["puckerRight"+s]=frames["puckerLeft"+s];}
 return opposite;
}
const frontLayers={
 leftEye:{atlas:"eyes",dest:[558,393,156,110],flipX:false},
 rightEye:{atlas:"eyes",dest:[330,393,156,110],flipX:true},
 leftBrow:{atlas:"brows",dest:[566,360,137,51],flipX:true},
 rightBrow:{atlas:"brows",dest:[339,360,137,51],flipX:false,clip:[[330,414],[366,399],[398,370],[425,321],[416,374],[398,412],[445,407],[474,394],[497,370],[500,435],[330,435]]},
 mouth:{atlas:"mouth",dest:[475,541,96,84],flipX:false},
};
const layer=(atlas,dest,flipX=false,clip=null)=>({atlas,dest,flipX,clip});
const hidden={visible:false,clip:null};
function turned(id,yaw,pitch,near,far,mouth,browNear,browFar,clip,profile=false){
 // Static uniform atlas scale: retain the drawn perspective, never squash it.
 near=[...near.slice(0,3),near[2]*(profile?232/352:200/252)];
 far=[...far.slice(0,3),far[2]*156/106];
 mouth=[...mouth.slice(0,3),mouth[2]*228/240];
 const right=yaw>0,ne=right?"rightEye":"leftEye",fe=right?"leftEye":"rightEye",nb=right?"rightBrow":"leftBrow",fb=right?"leftBrow":"rightBrow";
 return {id,yaw,pitch,base:root+id+".png",layers:{
  [ne]:layer(profile?"profileEyes":"sideNear",near,profile?!right:right,clip),
  // On left diagonal views the long fringe completely occludes the far eye.
  [fe]:profile||id==="left40-up"||id==="left40-down"?hidden:layer("sideFar",far,!right,clip),
  [nb]:layer("brows",browNear,!right,clip),[fb]:profile||id==="left40-up"||id==="left40-down"?hidden:layer("brows",browFar,right,clip),
  mouth:layer((profile?"profileMouth":"sideMouth")+(right?"":"Left"),mouth,!right,clip),
 }};
}
export const LUNA_PAINTED_MANIFEST={
 version:1,width:1024,height:1536,base:v1+"base.png",
 sequences:{eyes:eyeKeys.slice(0,11),jaw:["closed","jaw10","jaw25","jaw45","jaw65","openWide"],pucker:["puckerSoft","puckerMid","pucker"],press:["pressSoft","pressMid","press"],puckerLeft:["puckerLeftSoft","puckerLeftMid","puckerLeft"],puckerRight:["puckerRightSoft","puckerRightMid","puckerRight"],funnel:["funnelSoft","funnel"]},
 atlases:{
  eyes:{src:root+"eyes.png",frames:frontEyes},
  sideNear:{src:root+"eyes-40.png",frames:sideNear},sideFar:{src:root+"eyes-40.png",frames:sideFar},
  profileEyes:{src:root+"eyes-65.png",frames:profileEyes},
  mouth:{src:root+"mouths.png",frames:frontMouth,flipFrames:["puckerRight"]},
  sideMouth:{src:root+"mouths-40.png",frames:sideMouth,flipFrames:["puckerRight"]},
  sideMouthLeft:{src:root+"mouths-40.png",frames:oppositeMouth(sideMouth),flipFrames:["puckerLeft"]},
  profileMouth:{src:root+"mouths-65.png",frames:profileMouth,flipFrames:["puckerRight"]},
  profileMouthLeft:{src:root+"mouths-65.png",frames:oppositeMouth(profileMouth),flipFrames:["puckerLeft"]},
  brows:{src:v1+"brows.png",frames:{neutral:[0,160,512,280],up:[512,160,512,280],down:[1024,160,512,280],worried:[0,640,512,280],outerUp:[512,640,512,280]}},
 },
 layers:frontLayers,
 poses:[
  {id:"front",yaw:0,pitch:0,base:v1+"base.png"},
  turned("right20",.33,0,[513,389,144,135],[700,386,64,120],[639,517,96,84],[521,361,128,48],[706,360,60,40],[[465,420],[565,400],[630,353],[671,276],[731,330],[781,402],[750,551],[633,655],[522,594]]),
  turned("left20",-.33,0,[443,380,144,135],[322,384,64,120],[363,502,96,84],[456,355,128,48],[320,357,60,40],[[306,415],[379,402],[421,331],[478,227],[548,300],[615,358],[592,518],[462,633],[350,542]]),
  turned("right40",.66,0,[558,383,144,135],[751,386,47,113],[687,508,88,77],[568,358,124,46],[754,360,44,38],[[495,415],[586,401],[665,355],[700,280],[775,350],[817,424],[796,524],[669,644],[550,590]]),
  turned("left40",-.66,0,[427,375,144,135],[304,383,47,113],[328,500,88,77],[440,350,124,46],[305,356,44,38],[[291,412],[342,386],[376,320],[430,226],[533,316],[605,369],[577,507],[419,630],[325,535]]),
  turned("right65",1,0,[657,369,130,88],[0,0,1,1],[753,489,62,64],[663,345,118,44],[0,0,1,1],[[592,385],[687,370],[747,348],[797,324],[824,422],[831,459],[794,510],[750,635],[651,610],[602,549]],true),
  turned("left65",-1,0,[300,367,130,88],[0,0,1,1],[271,489,62,64],[309,343,118,44],[0,0,1,1],[[297,393],[342,347],[382,275],[434,236],[501,326],[501,436],[450,536],[341,624],[303,549],[281,509],[254,457]],true),
  {id:"up",yaw:0,pitch:1,base:root+"up.png",layers:{
   leftEye:layer("eyes",[557,303,150,106]),rightEye:layer("eyes",[336,303,150,106],true),
   leftBrow:layer("brows",[563,278,132,49],true),rightBrow:layer("brows",[341,278,132,49],false,[[345,322],[416,280],[468,232],[490,330],[345,350]]),mouth:layer("mouth",[477,412,92,80]),
  }},
  {id:"down",yaw:0,pitch:-1,base:root+"down.png",layers:{
   leftEye:layer("eyes",[555,476,145,102],false,[[553,529],[607,446],[661,472],[700,486],[697,572],[552,580]]),
   rightEye:layer("eyes",[361,480,145,102],true,[[356,506],[406,503],[428,490],[457,530],[507,513],[507,585],[363,580]]),
   leftBrow:layer("brows",[563,455,128,48],true),rightBrow:hidden,mouth:layer("mouth",[480,598,92,80]),
  }},
  turned("right40-up",.66,1,[533,289,144,135],[728,281,47,113],[672,406,88,77],[544,266,124,46],[729,257,44,38],[[471,350],[553,311],[623,256],[668,180],[733,242],[775,337],[790,435],[736,580],[601,557],[503,492]]),
  turned("left40-up",-.66,1,[431,278,144,135],[320,281,47,113],[318,408,88,77],[444,255,124,46],[320,258,44,38],[[326,335],[383,300],[441,247],[481,174],[551,247],[632,321],[604,442],[496,549],[355,579],[309,450]]),
  turned("right40-down",.66,-1,[550,449,144,135],[737,448,47,113],[655,572,88,77],[562,426,124,46],[737,426,44,38],[[498,468],[573,448],[630,467],[695,434],[740,353],[793,373],[788,486],[738,599],[625,701],[526,617]]),
  turned("left40-down",-.66,-1,[418,422,144,135],[296,423,47,113],[327,545,88,77],[430,397,124,46],[295,398,44,38],[[289,465],[351,457],[396,403],[432,312],[488,347],[561,399],[553,512],[476,604],[430,665],[359,615],[304,538]]),
 ],
};
export const LUNA_PAINTED_RIG={face:{x:520,y:459,w:390,h:440},leftEye:{x:636,y:449,w:156,h:110},rightEye:{x:408,y:449,w:156,h:110},mouth:{x:523,y:580,w:96,h:84},skin:"#fce5d5",patchesEnabled:true};
