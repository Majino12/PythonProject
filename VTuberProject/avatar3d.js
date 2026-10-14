import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const TORSO_PROFILE = [[.265, .04], [.29, .25], [.335, .56], [.415, .85], [.37, .94], [.15, 1.015]];

function torsoRadius(y) {
  if (y <= TORSO_PROFILE[0][1]) return TORSO_PROFILE[0][0];
  for (let index = 1; index < TORSO_PROFILE.length; index += 1) {
    const [radius, height] = TORSO_PROFILE[index];
    const [previousRadius, previousHeight] = TORSO_PROFILE[index - 1];
    if (y <= height) return previousRadius + (radius - previousRadius) * (y - previousHeight) / (height - previousHeight);
  }
  return TORSO_PROFILE.at(-1)[0];
}

function garmentSurface(x, y, offset = .015) {
  return Math.sqrt(Math.max(.002, torsoRadius(y) ** 2 - x ** 2)) * .64 + offset;
}

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .76, metalness: 0, ...options });
}

function mesh(geometry, meshMaterial, { position, rotation, scale, name } = {}) {
  const value = new THREE.Mesh(geometry, meshMaterial);
  if (position) value.position.set(...position);
  if (rotation) value.rotation.set(...rotation);
  if (scale) value.scale.set(...scale);
  if (name) value.name = name;
  return value;
}

// The eye surfaces follow the same tapered ellipsoid as the face. Keeping all
// features on its surface makes a three-quarter/profile view work without
// billboard eyes, protruding eyeballs, or a second eye floating beside the nose.
function faceSurface(x, y) {
  const taper = y < -.03 ? 1 + y * .38 : 1;
  const verticalRadius = y < 0 ? .4488 : .51;
  return .005 + .38 * Math.sqrt(Math.max(.015, 1 - (x / (.455 * taper)) ** 2 - (y / verticalRadius) ** 2));
}

function facePanel(width, height, x, y, depth = .005) {
  const geometry = new THREE.PlaneGeometry(width, height, 18, 12);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    positions.setZ(i, faceSurface(x + positions.getX(i), y + positions.getY(i)) + depth);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function canvasTexture(draw, width = 512, height = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function curveMesh(points, radius, mat, name) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  return mesh(new THREE.TubeGeometry(curve, 24, radius, 6, false), mat, { name });
}

function conformHairRoot(vertex, name, rootEase) {
  if ((!name.startsWith("Swept_Fringe") && !name.includes("_Side_")) || vertex.y <= .17) return;
  // Keep the complete strip, not merely its centre line, within the scalp.
  const radial = Math.hypot(vertex.x / .498, (vertex.y - .018) / .56);
  if (radial > .975) {
    vertex.x *= .975 / radial;
    vertex.y = .018 + (vertex.y - .018) * .975 / radial;
  }
  if (name.startsWith("Swept_Fringe")) {
    const scalpZ = Math.sqrt(Math.max(.01, 1 - (vertex.x / .498) ** 2 - ((vertex.y - .018) / .56) ** 2)) * .415 - .027;
    const rootBlend = 1 - rootEase;
    vertex.z = vertex.z * (1 - rootBlend) + (scalpZ + .006) * rootBlend;
  }
}

// A curved, softly crowned strip: unlike cones it has flowing edges and a
// tapered end. The back and the layered fringe are actual exportable geometry.
function hairRibbon(points, width, mat, name) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  const vertices = [];
  const uv = [];
  const indices = [];
  const rows = 28;
  const columns = 8;
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows;
    const point = curve.getPoint(t);
    const tangent = curve.getTangent(t);
    const across = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    const rootProgress = clamp(t / .34);
    const rootEase = rootProgress * rootProgress * (3 - 2 * rootProgress);
    const breadth = width * (.04 + .96 * rootEase) * (1 - .96 * t ** 3);
    for (let col = 0; col <= columns; col += 1) {
      const u = col / columns;
      const vertex = point.clone().addScaledVector(across, (u - .5) * breadth);
      vertex.z += Math.sin(u * Math.PI) * breadth * .14;
      conformHairRoot(vertex, name, rootEase);
      vertices.push(vertex.x, vertex.y, vertex.z);
      uv.push(u, t);
      if (row < rows && col < columns) {
        const a = row * (columns + 1) + col;
        indices.push(a, a + 1, a + columns + 1, a + 1, a + columns + 2, a + columns + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return mesh(geometry, mat, { name });
}

function disposeObject(object) {
  const resources = new Set();
  object.traverse((child) => {
    if (child.geometry) resources.add(child.geometry);
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const entry of materials) {
      if (!entry) continue;
      resources.add(entry);
      // Eye artwork is generated locally and embedded in GLB exports.
      for (const property of ["map", "alphaMap", "normalMap", "roughnessMap", "emissiveMap"]) {
        if (entry[property]) resources.add(entry[property]);
      }
    }
    if (child.shadow) resources.add(child.shadow);
  });
  for (const resource of resources) resource.dispose?.();
}

export class Avatar3D {
  constructor(canvas) {
    if (!canvas) throw new Error("缺少 3D 画布");
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, .1, 100);
    this.camera.position.set(0, .09, 8.7);
    this.camera.lookAt(0, .09, 0);
    this.userYaw = 0;
    this.dragStart = null;
    this.activePointerId = null;
    this.disposed = false;
    this.background = "gradient";
    this.framing = "full";
    this.appearance = { hairStyle: "bob", faceWidth: 1, eyeScale: 1 };
    this.palette = { skin: "#f5d8ce", hair: "#c6bfdc", outfit: "#29334c", eyes: "#8b69bf", accent: "#9b86ce" };
    this.secondary = { yaw: 0, roll: 0 };
    this.lastUpdate = 0;
    this.#createStage();
    this.#buildAvatar();
    this.setPalette(this.palette);
    this.setBackground("gradient");
    this.#bindPointerControls();
  }

  #createStage() {
    this.scene.add(new THREE.HemisphereLight(0xfff7f5, 0xe2cbd1, 1.5));
    const key = new THREE.DirectionalLight(0xfff8f3, .95);
    key.position.set(-3, 3, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe7e5ff, .45);
    fill.position.set(3, 2, 3);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xdcc9ff, .8);
    rim.position.set(2, 3, -4);
    this.scene.add(rim);
    // A small soft contact shadow provides grounding without a distracting grid.
    const shadowTexture = canvasTexture((ctx, width, height) => {
      const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 2);
      gradient.addColorStop(0, "rgba(11,12,24,.32)");
      gradient.addColorStop(.45, "rgba(11,12,24,.15)");
      gradient.addColorStop(1, "rgba(11,12,24,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }, 256, 256);
    this.shadow = mesh(new THREE.PlaneGeometry(1.9, 1.4), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }), { position: [0, -2.07, 0], rotation: [-Math.PI / 2, 0, 0], name: "Soft_Contact_Shadow" });
    this.scene.add(this.shadow);
  }

  #buildAvatar() {
    const mats = this.materials = {
      skin: material(this.palette.skin, { roughness: .85 }),
      hair: material(this.palette.hair, { roughness: .63, side: THREE.DoubleSide }),
      hairLight: material("#d4cce6", { roughness: .64, side: THREE.DoubleSide }),
      outfit: material(this.palette.outfit),
      outfitDark: material("#20293d"),
      skirt: material(this.palette.accent, { roughness: .86 }),
      ivory: material("#fff4e7", { roughness: .92, side: THREE.DoubleSide }),
      eyeDark: material("#403749"),
      accent: material(this.palette.accent),
      gold: material("#c5af7c", { roughness: .49, metalness: .2 }),
      mouth: material("#ac6476"),
      mouthInner: new THREE.MeshBasicMaterial({ color: "#673d50" }),
      teeth: new THREE.MeshBasicMaterial({ color: "#fff3ed" }),
      tongue: new THREE.MeshBasicMaterial({ color: "#d58b9b" }),
      shoe: material("#242a3c", { roughness: .65 }),
      blush: new THREE.MeshBasicMaterial({ color: "#e991a1", transparent: true, opacity: .12, depthWrite: false }),
    };
    this.avatar = new THREE.Group();
    this.avatar.name = "MoeMotion_Studio_Avatar";
    this.scene.add(this.avatar);
    this.rigRoot = new THREE.Group();
    this.rigRoot.name = "Rig_Root";
    this.avatar.add(this.rigRoot);
    this.body = new THREE.Group();
    this.body.name = "Body_Rig";
    this.rigRoot.add(this.body);

    const torsoPoints = TORSO_PROFILE.map(([x, y]) => new THREE.Vector2(x, y));
    this.body.add(mesh(new THREE.LatheGeometry(torsoPoints, 48), mats.outfit, { scale: [1, 1, .64], name: "Tailored_Jacket" }));
    this.body.add(mesh(new THREE.CylinderGeometry(.073, .115, .25, 32), mats.skin, { position: [0, 1.07, 0], name: "Neck" }));
    this.body.add(mesh(new THREE.CylinderGeometry(.121, .145, .13, 32), mats.ivory, { position: [0, 1.065, 0], name: "Soft_High_Collar" }));
    const blouseGeometry = new THREE.PlaneGeometry(.38, .59, 20, 32);
    const blousePositions = blouseGeometry.attributes.position;
    for (let i = 0; i < blousePositions.count; i += 1) {
      const y = blousePositions.getY(i) + .735;
      const x = blousePositions.getX(i) * (1 - (y - .44) / .59 * .34);
      blousePositions.setXYZ(i, x, y, garmentSurface(x, y));
    }
    blouseGeometry.computeVertexNormals();
    this.body.add(mesh(blouseGeometry, mats.ivory, { name: "Ivory_Blouse" }));
    const makeCollar = (side) => {
      // Tessellate each lapel before wrapping it over the exact jacket profile;
      // a flat extruded quad floated in front of the chest and cut its neckline.
      const geometry = new THREE.BufferGeometry();
      const positions = [], indices = [];
      const segments = 20;
      for (let row = 0; row <= segments; row += 1) {
        const v = row / segments;
        for (let col = 0; col <= segments; col += 1) {
          const u = col / segments;
          const x = side * ((.10 + .25 * u) * (1 - v) + .22 * u * v);
          const y = (1.012 - .102 * u) * (1 - v) + (.79 - .15 * u) * v;
          positions.push(x, y, garmentSurface(x, y, .022));
          if (row < segments && col < segments) {
            const a = row * (segments + 1) + col;
            if (side > 0) indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
            else indices.push(a, a + 1, a + segments + 1, a + 1, a + segments + 2, a + segments + 1);
          }
        }
      }
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      return mesh(geometry, mats.ivory, { name: `Sailor_Collar_${side > 0 ? "Left" : "Right"}` });
    };
    this.body.add(makeCollar(1), makeCollar(-1));
    for (const side of [-1, 1]) {
      const bow = new THREE.Shape();
      bow.moveTo(0, .77); bow.bezierCurveTo(side * .08, .85, side * .22, .86, side * .19, .75); bow.bezierCurveTo(side * .17, .67, side * .06, .73, 0, .77);
      this.body.add(mesh(new THREE.ExtrudeGeometry(bow, { depth: .025, bevelEnabled: true, bevelSegments: 2, bevelSize: .01, bevelThickness: .012 }), mats.accent, { position: [0, 0, .269], name: `Ribbon_Bow_${side}` }));
      this.body.add(hairRibbon([[side * .015, .75, .29], [side * .05, .62, .275], [side * .10, .51, .25]], .07, mats.accent, `Ribbon_Tail_${side}`));
    }
    this.body.add(mesh(new THREE.SphereGeometry(.045, 16, 12), mats.gold, { position: [0, .765, .316], scale: [.75, 1, .4], name: "Ribbon_Clasp" }));
    for (const y of [.32, .17]) this.body.add(mesh(new THREE.SphereGeometry(.021, 12, 8), mats.gold, { position: [0, y, .202], scale: [1, 1, .4], name: "Jacket_Button" }));
    const skirtGeometry = new THREE.CylinderGeometry(.277, .54, .60, 72, 4, true);
    const skirtPositions = skirtGeometry.attributes.position;
    for (let i = 0; i < skirtPositions.count; i += 1) {
      const x = skirtPositions.getX(i), z = skirtPositions.getZ(i), y = skirtPositions.getY(i);
      const pleat = 1 + Math.cos(Math.atan2(z, x) * 18) * .025 * (.65 - y);
      skirtPositions.setXYZ(i, x * pleat, y, z * pleat * .69);
    }
    skirtGeometry.computeVertexNormals();
    this.body.add(mesh(skirtGeometry, mats.skirt, { position: [0, -.26, 0], name: "Pleated_A_Line_Skirt" }));
    this.body.add(mesh(new THREE.TorusGeometry(.278, .018, 8, 48), mats.accent, { position: [0, .043, 0], rotation: [Math.PI / 2, 0, 0], scale: [1, .69, 1], name: "Waist_Ribbon" }));
    this.body.add(mesh(new THREE.TorusGeometry(.536, .013, 8, 72), mats.ivory, { position: [0, -.55, 0], rotation: [Math.PI / 2, 0, 0], scale: [1, .69, 1], name: "Skirt_Hem" }));

    this.head = new THREE.Group();
    this.head.name = "Head_Rig";
    this.head.position.set(0, 1.53, 0);
    this.head.scale.setScalar(.77);
    this.body.add(this.head);
    this.headContent = new THREE.Group();
    this.headContent.name = "Head_Proportions";
    this.head.add(this.headContent);
    const faceGeometry = new THREE.SphereGeometry(1, 56, 40);
    const facePositions = faceGeometry.attributes.position;
    for (let i = 0; i < facePositions.count; i += 1) {
      const y = facePositions.getY(i) * (facePositions.getY(i) < 0 ? .4488 : .51);
      facePositions.setXYZ(i, facePositions.getX(i) * .455 * (y < -.03 ? 1 + y * .38 : 1), y, facePositions.getZ(i) * .38 + .005);
    }
    faceGeometry.computeVertexNormals();
    this.face = mesh(faceGeometry, mats.skin, { name: "Soft_Tapered_Face" });
    this.headContent.add(this.face);
    for (const side of [-1, 1]) this.headContent.add(mesh(new THREE.SphereGeometry(.065, 20, 14), mats.skin, { position: [side * .422, -.055, -.008], scale: [.55, 1.15, .7], name: `Ear_${side}` }));
    this.#createHair(mats);
    this.eyeLeft = this.#createEye(.192, mats, "Left");
    this.eyeRight = this.#createEye(-.192, mats, "Right");
    this.headContent.add(this.eyeLeft, this.eyeRight);
    const brow = (side) => {
      const x = side * .19;
      const result = curveMesh([[-.112, -.008, faceSurface(x - .112, .172) + .007], [0, .018, faceSurface(x, .198) + .007], [.104, 0, faceSurface(x + .104, .18) + .007]], .0065, mats.eyeDark, `Brow_${side}`);
      result.position.set(x, .18, 0);
      return result;
    };
    this.browLeft = brow(1);
    this.browRight = brow(-1);
    this.headContent.add(this.browLeft, this.browRight);
    this.mouthRig = new THREE.Group();
    this.mouthRig.name = "Mouth_Rig";
    this.mouthRig.position.set(0, -.238, faceSurface(0, -.238) + .006);
    this.mouth = mesh(new THREE.CircleGeometry(.053, 32), mats.mouthInner, { scale: [1, .12, 1], name: "Mouth_Opening" });
    this.lip = curveMesh([[-.057, .004, .002], [0, -.005, .008], [.057, .004, .002]], .0035, mats.mouth, "Soft_Lip_Line");
    this.teeth = mesh(new THREE.PlaneGeometry(.067, .018), mats.teeth, { position: [0, .026, .002], name: "Teeth" });
    this.tongue = mesh(new THREE.CircleGeometry(.026, 20), mats.tongue, { position: [0, -.028, .003], scale: [1, .4, 1], name: "Tongue" });
    this.teeth.visible = false;
    this.tongue.visible = false;
    this.mouthRig.add(this.mouth, this.lip, this.teeth, this.tongue);
    this.headContent.add(this.mouthRig);
    for (const side of [-1, 1]) {
      const cheek = mesh(new THREE.CircleGeometry(.045, 24), mats.blush, { position: [side * .273, -.089, faceSurface(side * .273, -.089) + .006], rotation: [0, side * .49, 0], scale: [1.15, .38, 1], name: `Cheek_${side}` });
      this.headContent.add(cheek);
    }
    this.headContent.add(mesh(new THREE.SphereGeometry(.027, 20, 14), mats.skin, { position: [0, -.087, faceSurface(0, -.087) - .008], scale: [.68, 1.3, 1.18], name: "Subtle_Nose" }));
    this.armLeft = this.#createArm(1, mats, "Left");
    this.armRight = this.#createArm(-1, mats, "Right");
    this.legLeft = this.#createLeg(1, mats, "Left");
    this.legRight = this.#createLeg(-1, mats, "Right");
    this.body.add(this.armLeft, this.armRight, this.legLeft, this.legRight);
  }

  #createHair(mats) {
    const capGeometry = new THREE.BufferGeometry();
    const capVertices = [], capIndices = [];
    const capRows = 36, capColumns = 72;
    for (let row = 0; row <= capRows; row += 1) {
      for (let col = 0; col <= capColumns; col += 1) {
        const phi = col / capColumns * Math.PI * 2;
        const front = Math.max(0, Math.cos(phi));
        const theta = row / capRows * (2.08 - .91 * front ** 3);
        capVertices.push(Math.sin(phi) * Math.sin(theta) * .498, Math.cos(theta) * .56 + .018, Math.cos(phi) * Math.sin(theta) * .415 - .027);
        if (row < capRows && col < capColumns) {
          const a = row * (capColumns + 1) + col;
          capIndices.push(a, a + capColumns + 1, a + 1, a + 1, a + capColumns + 1, a + capColumns + 2);
        }
      }
    }
    capGeometry.setAttribute("position", new THREE.Float32BufferAttribute(capVertices, 3));
    capGeometry.setIndex(capIndices);
    capGeometry.computeVertexNormals();
    this.headContent.add(mesh(capGeometry, mats.hair, { name: "Layered_Hair_Crown" }));
    const fringes = [
      { p: [[-.28, .45, .14], [-.22, .35, .34], [-.055, .24, .404], [.13, .16, .374]], w: .17 },
      { p: [[-.10, .53, .09], [-.025, .41, .34], [.16, .30, .365], [.29, .13, .305]], w: .19 },
      { p: [[-.39, .30, .10], [-.40, .18, .235], [-.34, .02, .265], [-.365, -.12, .221]], w: .105 },
      { p: [[.14, .49, .11], [.35, .31, .27], [.39, .04, .246], [.385, -.22, .155]], w: .14 },
    ];
    fringes.forEach(({ p, w }, i) => this.headContent.add(hairRibbon(p, w, i === 1 ? mats.hairLight : mats.hair, `Swept_Fringe_${i}`)));
    this.hairStyles = {};
    for (const style of ["bob", "long", "short"]) {
      const group = new THREE.Group();
      group.name = `Hair_Style_${style}`;
      group.visible = style === "bob";
      const length = style === "long" ? 1.33 : style === "short" ? .31 : .62;
      for (const side of [-1, 1]) {
        for (let layer = 0; layer < 4; layer += 1) {
          const depth = .045 - layer * .12;
          const x = .442 - layer * .026;
          group.add(hairRibbon([[side * (x - .035), .34, depth], [side * (x + .055), -.02, depth - .025], [side * (x + .028), -length * .70, depth + .015], [side * (x - .055), -length, depth + .075]], .19, layer % 3 === 0 ? mats.hairLight : mats.hair, `${style}_Side_${side}_${layer}`));
        }
      }
      for (let layer = 0; layer < 7; layer += 1) {
        const x = (layer - 3) * .117;
        group.add(hairRibbon([[x, .22, -.35], [x * 1.13, -.04, -.409], [x * 1.17, -length * .76, -.37], [x * .98, -length - .04, -.25]], .19, layer % 3 === 1 ? mats.hairLight : mats.hair, `${style}_Back_${layer}`));
      }
      this.hairStyles[style] = group;
      this.headContent.add(group);
    }
    this.headContent.add(curveMesh([[.34, .34, .302], [.385, .31, .27], [.411, .28, .235]], .012, mats.gold, "Small_Hair_Pin"));
  }

  #createEye(x, mats, label) {
    const eye = new THREE.Group();
    eye.name = `Eye_${label}`;
    eye.position.set(x, .025, 0);
    const scleraTexture = canvasTexture((ctx, width, height) => {
      const mirror = x < 0;
      if (mirror) { ctx.translate(width, 0); ctx.scale(-1, 1); }
      ctx.beginPath();
      ctx.moveTo(12, 146);
      ctx.bezierCurveTo(112, 34, 321, 30, 500, 102);
      ctx.bezierCurveTo(359, 236, 125, 217, 12, 146);
      ctx.fillStyle = "#fff9f5";
      ctx.fill();
      ctx.strokeStyle = "#5b405c";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(13, 144); ctx.bezierCurveTo(112, 30, 319, 24, 500, 101);
      ctx.lineWidth = 16; ctx.lineCap = "round"; ctx.strokeStyle = "#3e334b"; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(436, 74); ctx.quadraticCurveTo(478, 77, 510, 52); ctx.lineTo(492, 104); ctx.closePath(); ctx.fillStyle = "#3e334b"; ctx.fill();
    });
    const scleraMaterial = new THREE.MeshBasicMaterial({ map: scleraTexture, transparent: true, alphaTest: .04, depthWrite: false });
    eye.add(mesh(facePanel(.315, .185, x, .025, .006), scleraMaterial, { name: `Almond_Eyelids_${label}` }));
    const gaze = new THREE.Group();
    gaze.name = `Gaze_${label}_Rig`;
    const irisMaterial = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: .025, depthWrite: false });
    gaze.add(mesh(facePanel(.155, .145, x, .025, .010), irisMaterial, { name: `Painted_Iris_${label}` }));
    eye.userData.irisMaterial = irisMaterial;
    eye.userData.gaze = gaze;
    eye.add(gaze);
    return eye;
  }

  #updateEyeArtwork() {
    const texture = canvasTexture((ctx, width, height) => {
      const cx = width / 2;
      ctx.save();
      ctx.scale(1, height / width);
      ctx.beginPath(); ctx.arc(cx, cx, width * .46, 0, Math.PI * 2); ctx.clip();
      const gradient = ctx.createLinearGradient(0, width * .1, 0, width);
      gradient.addColorStop(0, "#302342");
      gradient.addColorStop(.45, this.palette.eyes);
      gradient.addColorStop(1, "#e5d6fa");
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, width);
      ctx.beginPath(); ctx.ellipse(cx, width * .48, width * .13, width * .235, 0, 0, Math.PI * 2); ctx.fillStyle = "#342540"; ctx.fill();
      ctx.beginPath(); ctx.ellipse(width * .30, width * .28, width * .105, width * .135, -.3, 0, Math.PI * 2); ctx.fillStyle = "#fffcff"; ctx.fill();
      ctx.beginPath(); ctx.arc(width * .68, width * .69, width * .052, 0, Math.PI * 2); ctx.fillStyle = "#fff1fc"; ctx.fill();
      ctx.restore();
    }, 256, 256);
    const previous = new Set();
    for (const eye of [this.eyeLeft, this.eyeRight]) {
      if (eye.userData.irisMaterial.map) previous.add(eye.userData.irisMaterial.map);
      eye.userData.irisMaterial.map = texture;
      eye.userData.irisMaterial.needsUpdate = true;
    }
    previous.forEach((entry) => entry.dispose());
  }

  #createArm(side, mats, label) {
    const shoulder = new THREE.Group();
    shoulder.name = `Shoulder_${label}_Rig`;
    shoulder.position.set(side * .402, .91, -.012);
    shoulder.add(mesh(new THREE.CapsuleGeometry(.12, .32, 8, 20), mats.outfit, { position: [side * .011, -.24, 0], scale: [1, 1, .85], name: `Jacket_Sleeve_${label}` }));
    const elbow = new THREE.Group();
    elbow.name = `Elbow_${label}_Rig`;
    elbow.position.set(side * .024, -.48, 0);
    elbow.add(mesh(new THREE.SphereGeometry(.087, 20, 16), mats.outfit, { name: `Soft_Elbow_${label}` }));
    elbow.add(mesh(new THREE.CapsuleGeometry(.084, .30, 8, 20), mats.outfit, { position: [0, -.217, .006], scale: [1, 1, .9], name: `Lower_Sleeve_${label}` }));
    elbow.add(mesh(new THREE.CylinderGeometry(.087, .086, .083, 24), mats.ivory, { position: [0, -.443, .006], scale: [1, 1, .86], name: `Ivory_Cuff_${label}` }));
    const hand = new THREE.Group();
    hand.name = `Wrist_${label}_Rig`;
    hand.position.set(0, -.492, .009);
    hand.add(mesh(new THREE.CapsuleGeometry(.053, .066, 6, 18), mats.skin, { position: [0, -.075, 0], scale: [1, 1, .56], name: `Palm_${label}` }));
    for (let finger = 0; finger < 4; finger += 1) hand.add(mesh(new THREE.CapsuleGeometry(.013, .052 + (finger === 1 || finger === 2 ? .014 : 0), 4, 10), mats.skin, { position: [(finger - 1.5) * .025, -.143 - (finger === 1 || finger === 2 ? .007 : 0), .003], scale: [1, 1, .8], name: `Finger_${label}_${finger}` }));
    hand.add(mesh(new THREE.CapsuleGeometry(.021, .044, 4, 12), mats.skin, { position: [-side * .055, -.071, .015], rotation: [0, 0, -side * .38], name: `Thumb_${label}` }));
    elbow.add(hand);
    shoulder.add(elbow);
    shoulder.userData = { side, elbow, hand, angle: .07, bend: .11, direction: 1 };
    return shoulder;
  }

  #createLeg(side, mats, label) {
    const hip = new THREE.Group();
    hip.name = `Hip_${label}_Rig`;
    hip.position.set(side * .175, -.41, 0);
    hip.add(mesh(new THREE.CapsuleGeometry(.121, .44, 8, 24), mats.outfitDark, { position: [0, -.305, 0], scale: [1, 1, .90], name: `Thigh_${label}` }));
    const knee = new THREE.Group();
    knee.name = `Knee_${label}_Rig`;
    knee.position.set(0, -.65, .008);
    knee.add(mesh(new THREE.SphereGeometry(.098, 20, 16), mats.outfitDark, { scale: [1, 1, .96], name: `Soft_Knee_${label}` }));
    knee.add(mesh(new THREE.CapsuleGeometry(.086, .54, 8, 24), mats.outfitDark, { position: [0, -.35, -.012], scale: [1, 1, .96], name: `Stocking_${label}` }));
    knee.add(mesh(new THREE.CylinderGeometry(.091, .102, .34, 24), mats.shoe, { position: [0, -.707, -.006], name: `Ankle_Boot_${label}` }));
    knee.add(mesh(new THREE.SphereGeometry(.123, 24, 16), mats.shoe, { position: [0, -.868, .075], scale: [.88, .56, 1.65], name: `Boot_Toe_${label}` }));
    knee.add(mesh(new THREE.TorusGeometry(.092, .009, 8, 28), mats.gold, { position: [0, -.548, -.008], rotation: [Math.PI / 2, 0, 0], name: `Boot_Trim_${label}` }));
    hip.add(knee);
    hip.userData = { side, knee };
    return hip;
  }

  #bindPointerControls() {
    this.controlsController = new AbortController();
    const options = { signal: this.controlsController.signal };
    this.canvas.addEventListener("pointerdown", (event) => {
      this.dragStart = { x: event.clientX, yaw: this.userYaw };
      this.activePointerId = event.pointerId;
      this.canvas.setPointerCapture?.(event.pointerId);
      this.canvas.classList.add("dragging");
    }, options);
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.dragStart) return;
      this.userYaw = clamp(this.dragStart.yaw + (event.clientX - this.dragStart.x) * .009, -1.45, 1.45);
    }, options);
    const endDrag = (event) => {
      this.dragStart = null;
      this.activePointerId = null;
      if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.canvas.classList.remove("dragging");
    };
    this.canvas.addEventListener("pointerup", endDrag, options);
    this.canvas.addEventListener("pointercancel", endDrag, options);
    this.canvas.addEventListener("lostpointercapture", endDrag, options);
    this.canvas.addEventListener("dblclick", () => { this.userYaw = 0; }, options);
    this.canvas.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        this.userYaw = clamp(this.userYaw + (event.key === "ArrowLeft" ? -.15 : .15), -1.45, 1.45);
        event.preventDefault();
      } else if (event.key === "Home" || event.key === "Enter" || event.key === " ") {
        this.userYaw = 0;
        event.preventDefault();
      }
    }, options);
  }

  setPalette(nextPalette = {}) {
    const previousEyes = this.palette.eyes;
    for (const key of ["skin", "hair", "outfit", "eyes", "accent"]) {
      if (typeof nextPalette[key] === "string" && /^#[\da-f]{6}$/i.test(nextPalette[key])) this.palette[key] = nextPalette[key];
    }
    for (const key of ["skin", "hair", "outfit", "accent"]) this.materials[key].color.set(this.palette[key]);
    this.materials.hairLight.color.set(this.palette.hair).lerp(new THREE.Color("#f5eaff"), .16);
    this.materials.outfitDark.color.set(this.palette.outfit).multiplyScalar(.66);
    this.materials.skirt.color.set(this.palette.accent).lerp(new THREE.Color(this.palette.outfit), .25);
    if (previousEyes !== this.palette.eyes || !this.eyeLeft.userData.irisMaterial.map) this.#updateEyeArtwork();
  }

  setAppearance(profile = {}) {
    if (["bob", "long", "short"].includes(profile.hairStyle)) this.appearance.hairStyle = profile.hairStyle;
    this.appearance.faceWidth = clamp(finite(profile.faceWidth, this.appearance.faceWidth), .85, 1.15);
    this.appearance.eyeScale = clamp(finite(profile.eyeScale, this.appearance.eyeScale), .85, 1.15);
    this.headContent.scale.x = this.appearance.faceWidth;
    for (const [style, group] of Object.entries(this.hairStyles)) group.visible = style === this.appearance.hairStyle;
    if (profile.palette) this.setPalette(profile.palette);
  }

  setBackground(mode) {
    this.background = mode;
    this.renderer.setClearColor(mode === "green" ? 0x00b140 : 0x191d2c, mode === "transparent" ? 0 : 1);
    this.shadow.visible = mode === "gradient";
  }

  setFraming(mode = "portrait") {
    this.framing = mode === "full" ? "full" : "portrait";
    const portrait = this.framing === "portrait";
    this.camera.position.set(0, portrait ? .86 : .09, portrait ? 5.15 : 8.7);
    this.camera.lookAt(0, portrait ? .86 : .09, 0);
    this.camera.updateProjectionMatrix();
  }

  update(motion = {}, intensity = {}) {
    if (this.exporting) return;
    const value = (key) => finite(motion[key]);
    const amount = (key, fallback) => clamp(finite(intensity[key], fallback), 0, 1.5);
    const headAmount = amount("head", .7), blinkAmount = amount("blink", .85), mouthAmount = amount("mouth", .9);
    const expressionAmount = amount("expression", 1), bodyAmount = amount("body", .75);
    const now = performance.now();
    const dt = clamp((now - (this.lastUpdate || now - 16)) / 1000, .001, .06);
    this.lastUpdate = now;
    const ease = 1 - Math.exp(-dt / .15);
    const trackedYaw = clamp(value("x") * 1.05 * headAmount, -1.22, 1.22);
    const headFollow = Math.sign(trackedYaw) * Math.max(0, Math.abs(trackedYaw) - .38) * .28;
    const smile = clamp(value("smile") * expressionAmount), frown = clamp(value("frown") * expressionAmount);
    const pucker = clamp(value("pucker") * expressionAmount), mouthOpen = clamp(value("mouth") * mouthAmount);
    const breath = Math.sin(now * .00165) * .0045 * clamp(bodyAmount);
    this.avatar.rotation.y = this.userYaw;
    this.rigRoot.position.set(clamp(value("hipSway"), -1, 1) * .042 * bodyAmount, clamp(value("bodyBob"), -1, 1) * .055 * bodyAmount + breath, 0);
    this.rigRoot.rotation.z = -clamp(value("bodyLean"), -1, 1) * .075 * bodyAmount;
    this.body.rotation.y = clamp(value("bodyTurn"), -1, 1) * .22 * bodyAmount + headFollow;
    this.body.rotation.z = clamp(value("armL") - value("armR"), -1, 1) * .012 * bodyAmount;
    this.head.rotation.set(-clamp(value("y"), -1, 1) * .27 * headAmount, trackedYaw - headFollow * .6, -clamp(value("roll"), -1, 1) * .22 * headAmount);
    this.secondary.yaw += (trackedYaw - this.secondary.yaw) * ease;
    this.secondary.roll += (this.head.rotation.z - this.secondary.roll) * ease;
    for (const group of Object.values(this.hairStyles)) {
      group.rotation.y = clamp(this.secondary.yaw - trackedYaw, -.4, .4) * .12;
      group.rotation.z = clamp(this.secondary.roll - this.head.rotation.z, -.35, .35) * .22;
    }
    const eyeScale = this.appearance.eyeScale;
    for (const [eye, suffix] of [[this.eyeLeft, "L"], [this.eyeRight, "R"]]) {
      const blink = clamp(value(`blink${suffix}`) * blinkAmount * 1.12);
      const wide = clamp(value(`eyeWide${suffix}`) * expressionAmount);
      eye.scale.set(eyeScale, eyeScale * Math.max(.055, .94 - blink * .91 + wide * .13 - smile * .06), 1);
      eye.userData.gaze.position.set(clamp(value("lookX"), -1, 1) * .013 * expressionAmount, clamp(value("lookY"), -1, 1) * .008 * expressionAmount, 0);
    }
    const browUp = clamp(value("browUp") * expressionAmount);
    for (const [brow, side, suffix] of [[this.browLeft, 1, "L"], [this.browRight, -1, "R"]]) {
      const down = clamp(value(`browDown${suffix}`) * expressionAmount);
      brow.position.y = .18 + browUp * .028 - down * .02;
      brow.rotation.z = side * (browUp * -.08 - down * .12 + frown * .08);
    }
    this.mouthRig.position.x = clamp(value("mouthX"), -1, 1) * .018 * expressionAmount;
    this.mouthRig.position.y = -.238 + smile * .009 - frown * .009 - mouthOpen * .016;
    this.mouth.scale.set(1 + smile * .34 - pucker * .38, .11 + mouthOpen * 1.2 + pucker * .17, 1);
    this.mouthRig.rotation.z = clamp(value("mouthX"), -1, 1) * .07;
    this.lip.visible = mouthOpen < .16;
    this.lip.scale.y = 1 + smile * 1.4 - frown * 2.2;
    this.teeth.visible = mouthOpen > .30 && pucker < .5;
    this.teeth.position.y = .009 + mouthOpen * .029;
    this.teeth.scale.x = 1 + smile * .15 - pucker * .3;
    this.tongue.visible = mouthOpen > .52;
    this.tongue.position.y = -.014 - mouthOpen * .025;
    this.materials.blush.opacity = .08 + clamp(value("cheek") * .15 + smile * .13) * expressionAmount;

    const applyArm = (rig, suffix) => {
      const side = rig.userData.side;
      const strength = clamp(bodyAmount / .85, 0, 1.15);
      // atan2(sin, cos) preserves the shoulder angle through overhead raises.
      // Scale the angle itself: interpolating its vector with (0,1) flips it
      // abruptly when a half-strength arm passes straight overhead.
      const angle = Math.atan2(value(`armSin${suffix}`), finite(motion[`armCos${suffix}`], 1));
      const targetAngle = clamp(angle * strength, -.28, 2.80);
      const bend = clamp(value(`elbow${suffix}`) * strength);
      rig.userData.angle += (targetAngle - rig.userData.angle) * (1 - Math.exp(-dt / .105));
      rig.userData.bend += (bend - rig.userData.bend) * (1 - Math.exp(-dt / .125));
      const depth = clamp(value(`armDepth${suffix}`) * strength, -.7, .7);
      const targetDirection = clamp(finite(motion[`elbowSide${suffix}`], 1), -1, 1);
      const previousDirection = finite(rig.userData.direction, 1);
      rig.userData.direction = previousDirection + (targetDirection - previousDirection) * (1 - Math.exp(-dt / .14));
      const direction = rig.userData.direction;
      rig.position.y = .91 + clamp((targetAngle - 1.1) / 1.6) * .035;
      rig.rotation.set(-depth * .32 - .035, side * depth * .1, side * (.07 + rig.userData.angle));
      rig.userData.elbow.rotation.z = -side * (.07 + rig.userData.bend * direction * 1.72);
      rig.userData.elbow.rotation.x = -.035 - Math.abs(depth) * .11 - rig.userData.bend * .075;
      rig.userData.hand.rotation.set(.035 + rig.userData.bend * .07, side * .07, -side * rig.userData.bend * direction * .10);
    };
    applyArm(this.armLeft, "L");
    applyArm(this.armRight, "R");
    for (const [leg, suffix] of [[this.legLeft, "L"], [this.legRight, "R"]]) {
      const lift = clamp(value(`leg${suffix}`) * bodyAmount);
      leg.rotation.x = lift * .23;
      leg.rotation.z = leg.userData.side * .018 + clamp(value("hipSway"), -1, 1) * .018 * bodyAmount;
      leg.userData.knee.rotation.x = -lift * .46;
    }
  }

  render() {
    const width = Math.max(1, Math.floor(this.canvas.clientWidth || 720));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight || 720));
    const pixelRatio = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.floor(width * pixelRatio) || this.canvas.height !== Math.floor(height * pixelRatio)) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }

  async exportGLB() {
    const transforms = [];
    this.avatar.traverse((object) => transforms.push({ object, position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(), visible: object.visible }));
    const blushOpacity = this.materials.blush.opacity;
    const secondary = { ...this.secondary };
    const armState = [this.armLeft, this.armRight].map((rig) => ({ angle: rig.userData.angle, bend: rig.userData.bend, direction: rig.userData.direction }));
    try {
      // Export a deterministic relaxed pose, not a random frame of the demo.
      for (const rig of [this.armLeft, this.armRight]) { rig.userData.angle = 0; rig.userData.bend = 0; }
      this.secondary = { yaw: 0, roll: 0 };
      this.update({ armCosL: 1, armCosR: 1, smile: .12 }, { head: 1, blink: 1, mouth: 1, expression: 1, body: 0 });
      this.exporting = true;
      this.avatar.rotation.y = 0;
      this.rigRoot.position.y = 0;
      this.avatar.updateMatrixWorld(true);
      const result = await new GLTFExporter().parseAsync(this.avatar, { binary: true, onlyVisible: true, trs: true, maxTextureSize: 2048 });
      if (!(result instanceof ArrayBuffer)) throw new Error("没有生成有效的 GLB 数据");
      return result;
    } finally {
      this.exporting = false;
      transforms.forEach(({ object, position, quaternion, scale, visible }) => { object.position.copy(position); object.quaternion.copy(quaternion); object.scale.copy(scale); object.visible = visible; });
      this.materials.blush.opacity = blushOpacity;
      this.secondary = secondary;
      [this.armLeft, this.armRight].forEach((rig, i) => Object.assign(rig.userData, armState[i]));
      this.avatar.updateMatrixWorld(true);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controlsController?.abort();
    if (this.activePointerId !== null && this.canvas.hasPointerCapture?.(this.activePointerId)) this.canvas.releasePointerCapture(this.activePointerId);
    this.activePointerId = null;
    this.dragStart = null;
    this.canvas.classList.remove("dragging");
    disposeObject(this.scene);
    this.scene.clear();
    this.renderer.dispose();
  }
}
