import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { recolorPixels, rebuildVrmWithTextures } from "./studio-palette.js";
import { solveStudioMotion } from "./studio-motion.js";

const DEFAULT_MODEL_URL = "./assets/pixiv-vrm1-sample.vrm";
const PALETTE_KEYS = ["skin", "hair", "outfit", "eyes", "accent"];
const MATERIAL_KINDS = Object.freeze({
  Hair_00_HAIR: "hair",
  HairBack_00_HAIR: "hair",
  EyeIris_00_EYE: "eyes",
  Tops_01_CLOTH: "outfit",
  Bottoms_01_CLOTH: "accent",
  Shoes_01_CLOTH: "outfit",
});
const BONE_NAMES = Object.freeze([
  "hips", "spine", "chest", "upperChest", "neck", "head",
  "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm",
  "leftLowerArm", "rightLowerArm", "leftHand", "rightHand",
]);
const EXPRESSION_NAMES = Object.freeze([
  "blinkLeft", "blinkRight", "happy", "sad", "surprised", "angry", "relaxed", "aa", "ih", "ou",
]);
const VALID_HEX = /^#[\da-f]{6}$/i;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function abortError() {
  return new DOMException("3D 模型载入已取消", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function disposeMaterial(material) {
  if (!material) return;
  for (const property of ["map", "shadeMultiplyTexture", "normalMap", "emissiveMap", "matcap"]) {
    material[property]?.dispose?.();
  }
  material.dispose?.();
}

function copyImageToCanvas(image) {
  const width = Number(image?.naturalWidth || image?.videoWidth || image?.width);
  const height = Number(image?.naturalHeight || image?.videoHeight || image?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    return { canvas, context, original: new Uint8ClampedArray(pixels.data), width, height };
  } catch (error) {
    console.warn("Could not read a VRM texture for recoloring", error);
    return null;
  }
}

function canvasTextureFrom(source, canvas) {
  const texture = source?.clone?.() || new THREE.CanvasTexture(canvas);
  // Texture.clone() intentionally shares its Source. Replace that Source
  // before changing the image, otherwise a recolored garment can mutate every
  // material that referenced the original glTF image.
  texture.source = new THREE.Source(canvas);
  texture.colorSpace = source?.colorSpace || THREE.SRGBColorSpace;
  texture.flipY = source?.flipY ?? false;
  texture.needsUpdate = true;
  return texture;
}

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    const done = (blob) => {
      if (!blob) {
        reject(new Error("无法编码 VRM 贴图"));
        return;
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    };
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob(done, "image/png");
      return;
    }
    try {
      const base64 = canvas.toDataURL("image/png").split(",")[1];
      const binary = atob(base64);
      resolve(Uint8Array.from(binary, (value) => value.charCodeAt(0)));
    } catch (error) {
      reject(error);
    }
  });
}

function findMaterials(root, parser) {
  const unique = new Set();
  const result = [];
  root.traverse((object) => {
    const values = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of values) {
      if (!material || unique.has(material)) continue;
      unique.add(material);
      const kind = MATERIAL_KINDS[material.name];
      if (!kind) continue;
      const association = parser?.associations?.get(material);
      result.push({ material, materialName: material.name, materialIndex: association?.materials, kind });
    }
  });
  return result;
}

function setColor(color, value) {
  if (color?.set) color.set(value);
}

function createStage(renderer, scene) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .84;
  // MToon already lifts its unshaded regions. A restrained three-light setup
  // keeps the face, pale hair and fabric texture visible instead of clipping
  // them all to white.
  scene.add(new THREE.HemisphereLight(0xfff7f4, 0x77758d, .50));
  const key = new THREE.DirectionalLight(0xfff4ed, 1.05);
  key.position.set(-2.8, 4.2, 5.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdcd7ff, .24);
  fill.position.set(3.6, 2.0, 4.2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xc8b8ff, .36);
  rim.position.set(1.5, 3.4, -4.0);
  scene.add(rim);
}

/**
 * High fidelity VRM runtime. It deliberately mirrors the public methods of the
 * lightweight Avatar3D so app.js can choose either engine without branching in
 * the motion, camera, screenshot, or recording paths.
 */
export class StudioAvatar3D {
  static async create(canvas, { url = DEFAULT_MODEL_URL, signal } = {}) {
    if (!canvas) throw new Error("缺少 3D 画布");
    throwIfAborted(signal);
    const response = await fetch(url, { signal, cache: "force-cache" });
    if (!response.ok) throw new Error(`精致 3D 模型载入失败（${response.status}）`);
    const source = await response.arrayBuffer();
    throwIfAborted(signal);
    if (source.byteLength < 20 || new DataView(source).getUint32(0, true) !== 0x46546c67) {
      throw new Error("精致 3D 模型文件无效");
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const baseUrl = new URL(url, window.location.href);
    baseUrl.pathname = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf("/") + 1);
    const gltf = await loader.parseAsync(source.slice(0), baseUrl.href);
    const vrm = gltf.userData.vrm;
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error("模型缺少 VRM 人形绑定");
    }
    if (signal?.aborted) {
      VRMUtils.deepDispose(vrm.scene);
      throwIfAborted(signal);
    }
    try {
      return new StudioAvatar3D(canvas, { gltf, vrm, source });
    } catch (error) {
      VRMUtils.deepDispose(vrm.scene);
      throw error;
    }
  }

  constructor(canvas, { gltf, vrm, source }) {
    this.canvas = canvas;
    this.gltf = gltf;
    this.vrm = vrm;
    this.originalVrm = source.slice(0);
    this.exportExtension = "vrm";
    this.modelStyle = "studio";
    this.supportsHairStyle = false;
    this.capabilities = Object.freeze({ hairStyle: false, recolor: true, exportVRM: true });
    this.disposed = false;
    this.background = "gradient";
    this.framing = "portrait";
    this.userYaw = 0;
    this.dragStart = null;
    this.activePointerId = null;
    this.lastUpdate = 0;
    this.palette = { skin: "#f5d8ce", hair: "#c6bfdc", outfit: "#29334c", eyes: "#8b69bf", accent: "#9b86ce" };
    this.exportMaterialChanges = {};

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(27, 1, .05, 100);
    this.scene.add(this.camera);
    createStage(this.renderer, this.scene);

    VRMUtils.rotateVRM0(vrm);
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.combineMorphs(vrm);
    vrm.scene.traverse((object) => { object.frustumCulled = false; });

    this.modelRoot = new THREE.Group();
    this.modelRoot.name = "MoeMotion_Studio_VRM";
    this.modelRoot.add(vrm.scene);
    this.scene.add(this.modelRoot);
    this.#normalizeModel();
    this.bones = new Map();
    for (const name of BONE_NAMES) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.bones.set(name, { node, rest: node.quaternion.clone() });
    }

    this.lookTarget = new THREE.Object3D();
    this.lookTarget.position.set(0, 1.30 - this.camera.position.y, -.75);
    this.camera.add(this.lookTarget);
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    this.materialEntries = findMaterials(vrm.scene, gltf.parser).map((entry) => {
      const sourceTexture = entry.material.map || entry.material.shadeMultiplyTexture;
      const pixels = copyImageToCanvas(sourceTexture?.image);
      const runtimeTexture = pixels ? canvasTextureFrom(sourceTexture, pixels.canvas) : null;
      if (runtimeTexture) {
        entry.material.map = runtimeTexture;
        if ("shadeMultiplyTexture" in entry.material) entry.material.shadeMultiplyTexture = runtimeTexture;
      }
      return { ...entry, pixels, runtimeTexture, sourceTexture, lastColor: null, exportChange: null };
    });
    this.#bindPointerControls();
    this.setBackground("gradient");
    this.setFraming("portrait");
  }

  #normalizeModel() {
    this.vrm.scene.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(this.vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.y) || size.y < .1) throw new Error("VRM 模型尺寸无效");
    const scale = 3.72 / size.y;
    this.vrm.scene.scale.setScalar(scale);
    this.vrm.scene.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(this.vrm.scene);
    const center = box.getCenter(new THREE.Vector3());
    this.vrm.scene.position.x -= center.x;
    this.vrm.scene.position.y += -2.0 - box.min.y;
    this.vrm.scene.position.z -= center.z;
    this.vrm.scene.updateMatrixWorld(true);
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
      } else if (["Home", "Enter", " "].includes(event.key)) {
        this.userYaw = 0;
        event.preventDefault();
      }
    }, options);
  }

  setPalette(nextPalette = {}) {
    this.setAppearance({ palette: nextPalette });
  }

  setAppearance(profile = {}) {
    if (this.disposed) return;
    const next = profile.palette || {};
    for (const key of PALETTE_KEYS) {
      if (typeof next[key] === "string" && VALID_HEX.test(next[key])) this.palette[key] = next[key];
    }
    const exportMaterialChanges = {};
    for (const entry of this.materialEntries) {
      const target = entry.kind === "accent" ? this.palette.accent : this.palette[entry.kind];
      if (!target) continue;
      const normalizedTarget = target.toLowerCase();
      if (entry.lastColor !== normalizedTarget || !entry.exportChange) {
        if (entry.pixels) {
          const recolored = recolorPixels(entry.pixels.original, target, { kind: entry.kind === "accent" ? "outfit" : entry.kind });
          const imageData = entry.pixels.context.createImageData(entry.pixels.width, entry.pixels.height);
          imageData.data.set(recolored);
          entry.pixels.context.putImageData(imageData, 0, 0);
          entry.runtimeTexture.needsUpdate = true;
          setColor(entry.material.color, "#ffffff");
          const targetColor = new THREE.Color(target);
          const shade = entry.kind === "eyes" ? .82 : .68;
          const outline = [targetColor.r * .16, targetColor.g * .16, targetColor.b * .16];
          setColor(entry.material.shadeColorFactor, new THREE.Color(shade, shade, shade));
          setColor(entry.material.outlineColorFactor, new THREE.Color(...outline));
          entry.exportChange = {
            baseColorFactor: [1, 1, 1, entry.material.opacity ?? 1],
            shadeColorFactor: [shade, shade, shade],
            outlineColorFactor: outline,
          };
        } else {
          setColor(entry.material.color, target);
          const color = new THREE.Color(target);
          const shade = [color.r * .62, color.g * .62, color.b * .62];
          const outline = [color.r * .16, color.g * .16, color.b * .16];
          setColor(entry.material.shadeColorFactor, new THREE.Color(...shade));
          setColor(entry.material.outlineColorFactor, new THREE.Color(...outline));
          entry.exportChange = {
            baseColorFactor: [color.r, color.g, color.b, entry.material.opacity ?? 1],
            shadeColorFactor: shade,
            outlineColorFactor: outline,
          };
        }
        entry.lastColor = normalizedTarget;
        entry.material.needsUpdate = true;
      }
      exportMaterialChanges[entry.materialName] = entry.exportChange;
    }
    this.exportMaterialChanges = exportMaterialChanges;
  }

  setBackground(mode) {
    this.background = ["gradient", "transparent", "green"].includes(mode) ? mode : "gradient";
    this.renderer.setClearColor(this.background === "green" ? 0x00b140 : 0x191d2c, this.background === "transparent" ? 0 : 1);
  }

  setFraming(mode = "portrait") {
    this.framing = mode === "full" ? "full" : "portrait";
    const portrait = this.framing === "portrait";
    const targetY = portrait ? .86 : -.12;
    const viewHeight = portrait ? 2.08 : 4.28;
    const distance = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * .5)));
    this.camera.position.set(0, targetY, distance);
    this.camera.lookAt(0, targetY, 0);
    this.camera.updateProjectionMatrix();
  }

  update(motion = {}, intensity = {}) {
    if (this.disposed) return;
    const now = performance.now();
    const dt = clamp((now - (this.lastUpdate || now - 16)) / 1000, .001, .06);
    this.lastUpdate = now;
    const solved = solveStudioMotion(motion, intensity);
    const delta = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, "XYZ");
    for (const [name, values] of Object.entries(solved.bones)) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      euler.set(values[0], values[1], values[2], "XYZ");
      delta.setFromEuler(euler);
      bone.node.quaternion.copy(bone.rest).multiply(delta);
    }
    const expressions = this.vrm.expressionManager;
    if (expressions) {
      for (const name of EXPRESSION_NAMES) {
        if (expressions.getExpression(name)) expressions.setValue(name, solved.expressions[name] || 0);
      }
    }
    // Keep the target just in front of the lens and around eye height. The old
    // distant target crossed behind the avatar in portrait framing, making the
    // eye bones turn away from the viewer.
    this.lookTarget.position.set(
      solved.look.x * .64,
      1.30 - this.camera.position.y + solved.look.y * .38,
      -.75,
    );
    this.modelRoot.rotation.y = this.userYaw;
    // Required by three-vrm: updates expressions, look-at, constraints and all
    // spring-bone hair/clothing chains after our normalized pose is applied.
    this.vrm.update(dt);
  }

  render() {
    if (this.disposed) return;
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
    if (this.disposed) throw new Error("3D 角色已经关闭");
    const textureReplacements = [];
    for (const entry of this.materialEntries) {
      if (!entry.pixels) continue;
      textureReplacements.push({
        materialName: entry.materialName,
        bytes: await canvasToPngBytes(entry.pixels.canvas),
        mimeType: "image/png",
        slots: ["baseColorTexture", "shadeMultiplyTexture"],
      });
    }
    return rebuildVrmWithTextures(this.originalVrm, {
      materialChanges: this.exportMaterialChanges,
      textureReplacements,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controlsController?.abort();
    if (this.activePointerId !== null && this.canvas.hasPointerCapture?.(this.activePointerId)) {
      this.canvas.releasePointerCapture(this.activePointerId);
    }
    this.activePointerId = null;
    this.dragStart = null;
    this.canvas.classList.remove("dragging");
    if (this.vrm.lookAt) this.vrm.lookAt.target = null;
    VRMUtils.deepDispose(this.vrm.scene);
    const originalTextures = new Set(this.materialEntries
      .filter((entry) => entry.runtimeTexture && entry.sourceTexture !== entry.runtimeTexture)
      .map((entry) => entry.sourceTexture).filter(Boolean));
    for (const texture of originalTextures) texture.dispose?.();
    for (const object of this.scene.children) {
      if (object === this.modelRoot || object === this.camera) continue;
      object.traverse?.((child) => {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(disposeMaterial);
      });
    }
    this.scene.clear();
    // Deliberately do not forceContextLoss: the same canvas is reused when the
    // user switches between studio and lightweight renderers.
    this.renderer.dispose();
  }
}

