import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? .7,
    metalness: options.metalness ?? 0,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
  });
}

function mesh(geometry, meshMaterial, { position, rotation, scale, name, castShadow = true } = {}) {
  const value = new THREE.Mesh(geometry, meshMaterial);
  if (position) value.position.set(...position);
  if (rotation) value.rotation.set(...rotation);
  if (scale) value.scale.set(...scale);
  if (name) value.name = name;
  value.castShadow = castShadow;
  value.receiveShadow = true;
  return value;
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((entry) => entry.dispose?.());
    else child.material?.dispose?.();
  });
}

export class Avatar3D {
  constructor(canvas) {
    if (!canvas) throw new Error("缺少 3D 画布");
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, .1, 100);
    this.camera.position.set(0, .3, 8.5);
    this.camera.lookAt(0, .3, 0);
    this.userYaw = 0;
    this.dragStart = null;
    this.background = "gradient";
    this.palette = {
      skin: "#f0c7cb",
      hair: "#2a1d3c",
      outfit: "#8f67ea",
      eyes: "#bc96ff",
      accent: "#ff83bd",
    };

    this.#createStage();
    this.#buildAvatar();
    this.setPalette(this.palette);
    this.setBackground("gradient");
    this.#bindPointerControls();
  }

  #createStage() {
    this.scene.add(new THREE.HemisphereLight(0xf3eaff, 0x271e38, 2.35));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(-3.5, 5, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xaa7cff, 2.4);
    rim.position.set(4, 2, -3);
    this.scene.add(rim);
    const fill = new THREE.PointLight(0xff79b8, 2.2, 12);
    fill.position.set(3, .5, 4);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(12, 18, 0x7651d1, 0x312641);
    this.grid.position.y = -2.12;
    this.grid.material.transparent = true;
    this.grid.material.opacity = .28;
    this.scene.add(this.grid);

    this.shadow = mesh(
      new THREE.CircleGeometry(1.45, 48),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: .3 }),
      { position: [0, -2.1, 0], rotation: [-Math.PI / 2, 0, 0], castShadow: false },
    );
    this.scene.add(this.shadow);
  }

  #buildAvatar() {
    const mats = this.materials = {
      skin: material(this.palette.skin, { roughness: .78 }),
      hair: material(this.palette.hair, { roughness: .64 }),
      outfit: material(this.palette.outfit, { roughness: .72 }),
      outfitDark: material("#4b347f", { roughness: .75 }),
      eyes: material(this.palette.eyes, { roughness: .42, emissive: this.palette.eyes, emissiveIntensity: .08 }),
      eyeWhite: material("#fff9ff", { roughness: .5 }),
      eyeDark: material("#1b1425", { roughness: .58 }),
      accent: material(this.palette.accent, { roughness: .55, emissive: this.palette.accent, emissiveIntensity: .07 }),
      mouth: material("#8c3b66", { roughness: .7 }),
      mouthInner: material("#41152e", { roughness: .78 }),
      teeth: material("#fff4f8", { roughness: .5 }),
      tongue: material("#ef7fa7", { roughness: .68 }),
      shoe: material("#211a2e", { roughness: .62 }),
      blush: new THREE.MeshBasicMaterial({ color: 0xff6d9f, transparent: true, opacity: 0, depthWrite: false }),
    };

    this.avatar = new THREE.Group();
    this.avatar.name = "MoeMotion_Avatar";
    this.scene.add(this.avatar);

    this.rigRoot = new THREE.Group();
    this.rigRoot.name = "Rig_Root";
    this.avatar.add(this.rigRoot);

    this.body = new THREE.Group();
    this.body.name = "Body_Rig";
    this.rigRoot.add(this.body);

    const torso = mesh(new THREE.CapsuleGeometry(.57, .72, 8, 24), mats.outfit, {
      position: [0, -.15, 0], scale: [1, 1, .74], name: "Torso",
    });
    this.body.add(torso);
    this.body.add(mesh(new THREE.SphereGeometry(.6, 32, 20), mats.outfitDark, {
      position: [0, -.8, 0], scale: [1, .52, .72], name: "Hips",
    }));
    this.body.add(mesh(new THREE.TorusGeometry(.34, .075, 12, 36, Math.PI), mats.accent, {
      position: [0, .3, .5], rotation: [0, 0, Math.PI], name: "Collar",
    }));
    this.body.add(mesh(new THREE.SphereGeometry(.095, 20, 12), mats.accent, {
      position: [0, .08, .58], scale: [1, 1.3, .62], name: "Chest_Gem",
    }));

    this.head = new THREE.Group();
    this.head.name = "Head_Rig";
    this.head.position.set(0, 1.05, 0);
    this.body.add(this.head);
    this.head.add(mesh(new THREE.SphereGeometry(.9, 40, 28), mats.hair, {
      position: [0, .22, -.08], scale: [1.06, 1.15, .8], name: "Hair_Back",
    }));
    this.face = mesh(new THREE.SphereGeometry(.78, 40, 28), mats.skin, {
      position: [0, .14, .18], scale: [1, 1.08, .78], name: "Face",
    });
    this.head.add(this.face);

    const earGeometry = new THREE.ConeGeometry(.24, .62, 4);
    this.head.add(mesh(earGeometry, mats.hair, {
      position: [-.55, .92, -.02], rotation: [0, 0, -.23], scale: [1, 1, .72], name: "Ear_Left",
    }));
    this.head.add(mesh(earGeometry, mats.hair, {
      position: [.55, .92, -.02], rotation: [0, 0, .23], scale: [1, 1, .72], name: "Ear_Right",
    }));
    this.hairSideLeft = mesh(new THREE.SphereGeometry(.45, 28, 18), mats.hair, {
      position: [-.67, .13, -.03], scale: [.68, 1.28, .62], name: "Hair_Side_Left",
    });
    this.hairSideRight = mesh(new THREE.SphereGeometry(.45, 28, 18), mats.hair, {
      position: [.67, .13, -.03], scale: [.68, 1.28, .62], name: "Hair_Side_Right",
    });
    this.head.add(this.hairSideLeft, this.hairSideRight);

    const fringeGeometry = new THREE.ConeGeometry(.23, .72, 7);
    for (const [index, x] of [-.48, -.24, 0, .24, .48].entries()) {
      this.head.add(mesh(fringeGeometry, mats.hair, {
        position: [x, .55 - Math.abs(x) * .16, .65],
        rotation: [.16, 0, x * .34],
        scale: [index === 2 ? 1.12 : .92, 1, .7],
        name: `Hair_Fringe_${index + 1}`,
      }));
    }

    this.eyeLeft = this.#createEye(.3, mats, "Left");
    this.eyeRight = this.#createEye(-.3, mats, "Right");
    this.head.add(this.eyeLeft, this.eyeRight);
    this.browLeft = mesh(new THREE.CapsuleGeometry(.025, .14, 4, 10), mats.eyeDark, {
      position: [.3, .51, .8], rotation: [0, 0, Math.PI / 2], name: "Brow_Left",
    });
    this.browRight = mesh(new THREE.CapsuleGeometry(.025, .14, 4, 10), mats.eyeDark, {
      position: [-.3, .51, .8], rotation: [0, 0, Math.PI / 2], name: "Brow_Right",
    });
    this.head.add(this.browLeft, this.browRight);

    this.mouthRig = new THREE.Group();
    this.mouthRig.name = "Mouth_Rig";
    this.mouthRig.position.set(0, -.16, .82);
    this.mouth = mesh(new THREE.SphereGeometry(.13, 24, 16), mats.mouthInner, {
      scale: [1.15, .22, .34], name: "Mouth_Inner",
    });
    this.teeth = mesh(new THREE.BoxGeometry(.17, .045, .025), mats.teeth, {
      position: [0, .025, .055], scale: [1, .55, 1], name: "Teeth",
    });
    this.tongue = mesh(new THREE.SphereGeometry(.075, 18, 10), mats.tongue, {
      position: [0, -.055, .055], scale: [1.1, .38, .32], name: "Tongue",
    });
    this.teeth.visible = false;
    this.tongue.visible = false;
    this.mouthRig.add(this.mouth, this.teeth, this.tongue);
    this.head.add(this.mouthRig);
    this.cheekLeft = mesh(new THREE.SphereGeometry(.12, 20, 12), mats.blush, {
      position: [-.51, -.02, .75], scale: [1.45, .42, .18], name: "Cheek_Left", castShadow: false,
    });
    this.cheekRight = mesh(new THREE.SphereGeometry(.12, 20, 12), mats.blush, {
      position: [.51, -.02, .75], scale: [1.45, .42, .18], name: "Cheek_Right", castShadow: false,
    });
    this.head.add(this.cheekLeft, this.cheekRight);
    this.head.add(mesh(new THREE.SphereGeometry(.025, 12, 8), mats.skin, {
      position: [0, .02, .84], scale: [.75, 1, .4], name: "Nose",
    }));

    this.armLeft = this.#createArm(1, mats, "Left");
    this.armRight = this.#createArm(-1, mats, "Right");
    this.body.add(this.armLeft, this.armRight);
    this.legLeft = this.#createLeg(1, mats, "Left");
    this.legRight = this.#createLeg(-1, mats, "Right");
    this.body.add(this.legLeft, this.legRight);

    const star = new THREE.Shape();
    for (let pointIndex = 0; pointIndex < 10; pointIndex += 1) {
      const radius = pointIndex % 2 ? .11 : .23;
      const angle = pointIndex * Math.PI / 5 - Math.PI / 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (pointIndex === 0) star.moveTo(x, y); else star.lineTo(x, y);
    }
    star.closePath();
    this.head.add(mesh(new THREE.ExtrudeGeometry(star, { depth: .055, bevelEnabled: true, bevelSize: .018, bevelThickness: .018 }), mats.accent, {
      position: [.47, .9, .53], rotation: [0, 0, -.22], scale: [.85, .85, .85], name: "Hair_Star",
    }));
  }

  #createEye(x, mats, side) {
    const eye = new THREE.Group();
    eye.name = `Eye_${side}`;
    eye.position.set(x, .25, .79);
    eye.add(mesh(new THREE.SphereGeometry(.19, 28, 18), mats.eyeWhite, {
      scale: [1.18, .86, .35], name: `Eye_White_${side}`,
    }));
    const gaze = new THREE.Group();
    gaze.name = `Gaze_${side}_Rig`;
    gaze.add(mesh(new THREE.SphereGeometry(.105, 24, 16), mats.eyes, {
      position: [0, -.005, .075], scale: [.92, 1.15, .42], name: `Iris_${side}`,
    }));
    gaze.add(mesh(new THREE.SphereGeometry(.045, 18, 12), mats.eyeDark, {
      position: [0, -.012, .117], scale: [.8, 1.1, .4], name: `Pupil_${side}`,
    }));
    gaze.add(mesh(new THREE.SphereGeometry(.026, 12, 8), mats.eyeWhite, {
      position: [-.035, .045, .145], name: `Eye_Highlight_${side}`,
    }));
    eye.add(gaze);
    eye.userData.gaze = gaze;
    return eye;
  }

  #createArm(side, mats, label) {
    const shoulder = new THREE.Group();
    shoulder.name = `Shoulder_${label}_Rig`;
    shoulder.position.set(side * .6, .4, -.01);
    const upperArm = mesh(new THREE.CapsuleGeometry(.155, .34, 6, 18), mats.outfit, {
      position: [side * .025, -.29, 0], scale: [1, 1, .8], name: `UpperArm_${label}`,
    });
    const elbow = new THREE.Group();
    elbow.name = `Elbow_${label}_Rig`;
    elbow.position.set(side * .045, -.58, 0);
    const forearm = mesh(new THREE.CapsuleGeometry(.12, .3, 6, 18), mats.skin, {
      position: [side * .025, -.26, .015], scale: [1, 1, .82], name: `Forearm_${label}`,
    });
    const cuff = mesh(new THREE.TorusGeometry(.13, .035, 10, 24), mats.accent, {
      position: [side * .045, -.47, .02], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, .82], name: `Cuff_${label}`,
    });
    const hand = mesh(new THREE.SphereGeometry(.18, 24, 16), mats.skin, {
      position: [side * .07, -.57, .035], scale: [.82, 1.03, .72], name: `Hand_${label}`,
    });
    elbow.add(forearm, cuff, hand);
    shoulder.add(upperArm, elbow);
    shoulder.userData.side = side;
    shoulder.userData.elbow = elbow;
    shoulder.userData.hand = hand;
    return shoulder;
  }

  #createLeg(side, mats, label) {
    const hip = new THREE.Group();
    hip.name = `Hip_${label}_Rig`;
    hip.position.set(side * .28, -.92, -.02);
    hip.add(mesh(new THREE.CapsuleGeometry(.2, .28, 6, 18), mats.skin, {
      position: [0, -.29, 0], scale: [.86, 1, .72], name: `Thigh_${label}`,
    }));
    const knee = new THREE.Group();
    knee.name = `Knee_${label}_Rig`;
    knee.position.set(0, -.58, 0);
    knee.add(mesh(new THREE.CapsuleGeometry(.17, .28, 6, 18), mats.skin, {
      position: [0, -.28, 0], scale: [.86, 1, .72], name: `Shin_${label}`,
    }));
    knee.add(mesh(new THREE.SphereGeometry(.25, 24, 16), mats.shoe, {
      position: [0, -.61, .13], scale: [.9, .58, 1.25], name: `Shoe_${label}`,
    }));
    hip.add(knee);
    hip.userData.side = side;
    hip.userData.knee = knee;
    return hip;
  }

  #bindPointerControls() {
    this.canvas.addEventListener("pointerdown", (event) => {
      this.dragStart = { x: event.clientX, yaw: this.userYaw };
      this.canvas.setPointerCapture?.(event.pointerId);
      this.canvas.classList.add("dragging");
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.dragStart) return;
      this.userYaw = clamp(this.dragStart.yaw + (event.clientX - this.dragStart.x) * .009, -1.45, 1.45);
    });
    const endDrag = (event) => {
      this.dragStart = null;
      this.canvas.releasePointerCapture?.(event.pointerId);
      this.canvas.classList.remove("dragging");
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
    this.canvas.addEventListener("dblclick", () => { this.userYaw = 0; });
    this.canvas.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        this.userYaw = clamp(this.userYaw + (event.key === "ArrowLeft" ? -.15 : .15), -1.45, 1.45);
        event.preventDefault();
      } else if (event.key === "Home" || event.key === "Enter" || event.key === " ") {
        this.userYaw = 0;
        event.preventDefault();
      }
    });
  }

  setPalette(nextPalette = {}) {
    this.palette = { ...this.palette, ...nextPalette };
    const set = (entry, value) => {
      entry.color.set(value);
      if (entry.emissiveIntensity) entry.emissive.set(value);
      entry.needsUpdate = true;
    };
    set(this.materials.skin, this.palette.skin);
    set(this.materials.hair, this.palette.hair);
    set(this.materials.outfit, this.palette.outfit);
    set(this.materials.outfitDark, new THREE.Color(this.palette.outfit).multiplyScalar(.54));
    set(this.materials.eyes, this.palette.eyes);
    set(this.materials.accent, this.palette.accent);
  }

  setBackground(mode) {
    this.background = mode;
    if (mode === "transparent") {
      this.renderer.setClearColor(0x000000, 0);
      this.grid.visible = false;
      this.shadow.visible = false;
    } else if (mode === "green") {
      this.renderer.setClearColor(0x00b140, 1);
      this.grid.visible = false;
      this.shadow.visible = true;
    } else {
      this.renderer.setClearColor(0x12101b, 1);
      this.grid.visible = true;
      this.shadow.visible = true;
    }
  }

  update(motion, intensity = {}) {
    if (this.exporting) return;
    const value = (key) => Number.isFinite(motion[key]) ? motion[key] : 0;
    const headAmount = intensity.head ?? .7;
    const blinkAmount = intensity.blink ?? .85;
    const mouthAmount = intensity.mouth ?? .9;
    const expressionAmount = intensity.expression ?? 1;
    const bodyAmount = intensity.body ?? .75;
    const blinkLeft = clamp(value("blinkL") * blinkAmount);
    const blinkRight = clamp(value("blinkR") * blinkAmount);
    const eyeWideLeft = clamp(value("eyeWideL") * expressionAmount);
    const eyeWideRight = clamp(value("eyeWideR") * expressionAmount);
    const mouthOpen = clamp(value("mouth") * mouthAmount);
    const smile = clamp(value("smile") * expressionAmount);
    const frown = clamp(value("frown") * expressionAmount);
    const pucker = clamp(value("pucker") * expressionAmount);
    const browUp = clamp(value("browUp") * expressionAmount);
    const browDownLeft = clamp(value("browDownL") * expressionAmount);
    const browDownRight = clamp(value("browDownR") * expressionAmount);
    const trackedYaw = clamp(value("x") * 1.1 * headAmount, -1.22, 1.22);
    const followAmount = clamp((Math.abs(trackedYaw) - .42) / .72);
    const headFollow = Math.sign(trackedYaw) * followAmount * Math.max(0, Math.abs(trackedYaw) - .34) * .34;
    const profileAmount = clamp((Math.abs(trackedYaw) - .48) / .66);
    const leftIsFar = trackedYaw > 0;
    const rightIsFar = trackedYaw < 0;

    this.avatar.rotation.y = this.userYaw;
    this.rigRoot.position.x = value("hipSway") * .08 * bodyAmount;
    this.rigRoot.position.y = value("bodyBob") * .12 * bodyAmount;
    this.rigRoot.rotation.z = -value("bodyLean") * .12 * bodyAmount;
    this.body.rotation.y = value("bodyTurn") * .34 * bodyAmount + headFollow;
    this.body.rotation.z = (value("armL") - value("armR")) * .025 * bodyAmount;
    this.head.rotation.set(
      -value("y") * .3 * headAmount,
      trackedYaw - headFollow * .65,
      -value("roll") * .27 * headAmount,
    );
    this.hairSideLeft.rotation.z = value("roll") * .055 * headAmount;
    this.hairSideRight.rotation.z = value("roll") * .055 * headAmount;

    const leftProfileScale = leftIsFar ? 1 - profileAmount * .82 : 1;
    const rightProfileScale = rightIsFar ? 1 - profileAmount * .82 : 1;
    this.eyeLeft.scale.set(leftProfileScale, Math.max(.045, 1 - blinkLeft * .96 + eyeWideLeft * .26), leftProfileScale);
    this.eyeRight.scale.set(rightProfileScale, Math.max(.045, 1 - blinkRight * .96 + eyeWideRight * .26), rightProfileScale);
    // Sink the far-side features into the face gradually so profile views read
    // as one eye instead of two floating, overlapping eyes.
    this.eyeLeft.position.z = .79 - (leftIsFar ? profileAmount * .24 : 0);
    this.eyeRight.position.z = .79 - (rightIsFar ? profileAmount * .24 : 0);
    const gazeX = value("lookX") * .055 * expressionAmount;
    const gazeY = value("lookY") * .04 * expressionAmount;
    this.eyeLeft.userData.gaze.position.set(gazeX, gazeY, 0);
    this.eyeRight.userData.gaze.position.set(gazeX, gazeY, 0);
    this.browLeft.position.y = .51 + browUp * .1 - browDownLeft * .075;
    this.browRight.position.y = .51 + browUp * .1 - browDownRight * .075;
    this.browLeft.position.z = .8 - (leftIsFar ? profileAmount * .2 : 0);
    this.browRight.position.z = .8 - (rightIsFar ? profileAmount * .2 : 0);
    this.browLeft.rotation.z = Math.PI / 2 - browUp * .16 - browDownLeft * .22;
    this.browRight.rotation.z = Math.PI / 2 + browUp * .16 + browDownRight * .22;

    const mouthWidth = clamp(1.15 + smile * .42 - frown * .18 - pucker * .58, .5, 1.62);
    const mouthHeight = .2 + mouthOpen * 1.65 + pucker * .22;
    this.mouthRig.position.x = value("mouthX") * .045 * expressionAmount;
    this.mouthRig.position.y = -.16 + smile * .018 - frown * .04 - mouthOpen * .035;
    this.mouthRig.rotation.z = value("mouthX") * .14 * expressionAmount;
    this.mouth.scale.set(mouthWidth, mouthHeight, .34 + mouthOpen * .2);
    this.teeth.visible = mouthOpen > .15 && pucker < .5;
    this.teeth.position.y = .015 + mouthOpen * .025;
    this.tongue.visible = mouthOpen > .24;
    this.tongue.position.y = -.035 - mouthOpen * .045;
    this.materials.blush.opacity = clamp((value("cheek") * .58 + smile * .32) * expressionAmount * .48, 0, .42);

    const applyArm = (rig, liftValue, angleSin, angleCos, elbowValue, elbowSideValue, depthValue) => {
      const side = rig.userData.side;
      const armAmount = clamp(bodyAmount / .75);
      const lift = clamp(liftValue * armAmount);
      const armAngle = Math.atan2(angleSin * armAmount, 1 + (angleCos - 1) * armAmount);
      const bend = clamp(elbowValue * armAmount);
      const bendDirection = clamp(elbowSideValue, -1, 1);
      const depth = clamp(depthValue * armAmount, -1, 1);
      const shoulderLift = clamp((lift - .55) / .45);
      rig.position.y = .4 + shoulderLift * shoulderLift * .07;
      rig.rotation.z = side * (.08 + armAngle);
      rig.rotation.x = -depth * .52;
      rig.rotation.y = side * depth * .16;
      rig.userData.elbow.rotation.z = -side * bend * bendDirection * 2.2;
      rig.userData.elbow.rotation.x = -depth * .18;
      rig.userData.hand.rotation.z = -side * bend * bendDirection * .16;
    };
    applyArm(this.armLeft, value("armL"), value("armSinL"), value("armCosL"), value("elbowL"), value("elbowSideL") || 1, value("armDepthL"));
    applyArm(this.armRight, value("armR"), value("armSinR"), value("armCosR"), value("elbowR"), value("elbowSideR") || 1, value("armDepthR"));

    const applyLeg = (rig, liftValue) => {
      const side = rig.userData.side;
      const lift = clamp(liftValue * bodyAmount);
      rig.rotation.x = lift * .34;
      rig.rotation.z = side * (.025 + value("hipSway") * .028 * bodyAmount);
      rig.userData.knee.rotation.x = -lift * .72;
    };
    applyLeg(this.legLeft, value("legL"));
    applyLeg(this.legRight, value("legR"));
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
    this.avatar.traverse((object) => {
      transforms.push({
        object,
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone(),
        visible: object.visible,
      });
    });
    const blushOpacity = this.materials.blush.opacity;
    try {
      this.update({
        x: 0, y: 0, roll: 0, blinkL: 0, blinkR: 0, eyeWideL: 0, eyeWideR: 0,
        lookX: 0, lookY: 0, mouth: 0, mouthX: 0, smile: .18, frown: 0, pucker: 0,
        browUp: 0, browDownL: 0, browDownR: 0, cheek: 0,
        bodyLean: 0, bodyBob: 0, bodyTurn: 0, hipSway: 0,
        armL: 0, armR: 0, elbowL: 0, elbowR: 0, elbowSideL: 1, elbowSideR: 1,
        armSinL: 0, armSinR: 0, armCosL: 1, armCosR: 1,
        armDepthL: 0, armDepthR: 0,
        legL: 0, legR: 0,
      }, { head: 1, blink: 1, mouth: 1, expression: 1, body: 1 });
      this.exporting = true;
      this.avatar.rotation.y = 0;
      this.avatar.updateMatrixWorld(true);
      const exporter = new GLTFExporter();
      const result = await exporter.parseAsync(this.avatar, {
        binary: true,
        onlyVisible: true,
        trs: true,
        maxTextureSize: 2048,
      });
      if (!(result instanceof ArrayBuffer)) throw new Error("没有生成有效的 GLB 数据");
      return result;
    } finally {
      this.exporting = false;
      transforms.forEach(({ object, position, quaternion, scale, visible }) => {
        object.position.copy(position);
        object.quaternion.copy(quaternion);
        object.scale.copy(scale);
        object.visible = visible;
      });
      this.materials.blush.opacity = blushOpacity;
      this.avatar.updateMatrixWorld(true);
    }
  }

  dispose() {
    disposeObject(this.avatar);
    this.renderer.dispose();
  }
}
