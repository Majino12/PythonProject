// Integer registration of the unmodified v4 PNGs. Every mouth uses the same
// square source size; upper-lip anchors keep jaw opening below the smile line.
// No tracking-dependent scaling, mesh deformation or generated vector lips.
// The prompt names VIEWER directions, whereas ARKit uses the character's
// anatomical side. Row-three viewer-left drawings therefore map to Right.
const keys = ["closed","jaw10","jaw25","jaw45","jaw65","openWide","puckerSoft","puckerMid","pucker","pressSoft","pressMid","press","puckerRightSoft","puckerRightMid","puckerRight","puckerLeftSoft","puckerLeftMid","puckerLeft","smileClosed","smileOpen","frownClosed","frownOpen","funnelSoft","funnel"];
const register = (anchors) => {
  const frames = Object.fromEntries(keys.map((key,i) => [key,[anchors[i][0]-90,anchors[i][1]-64,180,180]]));
  return {...frames,openSmall:frames.jaw10,openMedium:frames.jaw45,side:frames.puckerLeftSoft};
};
export const LUNA_MOUTH_ART = {
  mouth:{file:"mouths-front.png",neutralInkWidth:131,frames:register([
    [142,179],[395,165],[644,155],[892,142],[1147,124],[1406,113],
    [143,414],[398,412],[644,406],[894,414],[1154,412],[1406,409],
    [146,628],[393,630],[643,628],[898,638],[1154,637],[1403,635],
    [147,867],[398,838],[651,850],[894,842],[1151,828],[1404,825],
  ])},
  sideMouth:{file:"mouths-side.png",neutralInkWidth:145,frames:register([
    [131,190],[391,177],[645,176],[901,164],[1153,152],[1404,135],
    [159,435],[400,431],[666,437],[904,437],[1157,437],[1411,434],
    [115,649],[394,652],[650,654],[932,658],[1174,658],[1446,652],
    [139,893],[400,872],[649,879],[907,875],[1157,862],[1418,857],
  ])},
  profileMouth:{file:"mouths-profile.png",neutralInkWidth:155,frames:register([
    [145,177],[402,165],[650,160],[898,150],[1144,140],[1401,117],
    [140,400],[391,398],[645,397],[898,400],[1154,397],[1409,395],
    [147,633],[402,632],[662,632],[911,635],[1166,635],[1428,635],
    [144,877],[399,853],[647,861],[900,852],[1165,836],[1410,826],
  ])},
};

// Canonical anatomical RIGHT brow: outer tail LEFT, inner end RIGHT.
// Each row's neutral baseline is registered once, retaining the actual
// independently painted raise/furrow/inner/outer changes within that row.
export const LUNA_BROW_ART = {
  file:"brows.png",neutralInkWidth:293,anchor:[180,81],
  frames:{
    neutral:[18,58,360,180],upSoft:[400,58,360,180],upMid:[780,58,360,180],up:[1155,58,360,180],
    downSoft:[399,292,360,180],downMid:[779,292,360,180],down:[1156,292,360,180],
    worriedSoft:[399,550,360,180],worriedMid:[779,550,360,180],worried:[1155,550,360,180],
    outerUpSoft:[404,791,360,180],outerUpMid:[785,791,360,180],outerUp:[1161,791,360,180],
  },
};
