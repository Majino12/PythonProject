const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const amount = (value) => clamp(finite(value), 0, 1);

/** Public: normalize source-pixel rig geometry and limit all shader inputs. */
export function portraitWarpState(width, height, rig = {}, motion = {}, intensity = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || rig?.patchesEnabled === false) return null;
  rig ||= {};
  motion ||= {};
  intensity ||= {};
  const gain = (key) => clamp(finite(intensity[key], 1), 0, 1.5);
  const box = (value) => {
    if (!value || ![value.x, value.y, value.w, value.h].every(Number.isFinite)
      || value.x < 0 || value.x >= width || value.y < 0 || value.y >= height
      || value.w < 1 || value.h < 1 || value.w > width * .55 || value.h > height * .4) return [0, 0, 0, 0];
    return [value.x / width, value.y / height, value.w / width, value.h / height];
  };
  return {
    leftEye: box(rig.leftEye), rightEye: box(rig.rightEye), mouth: box(rig.mouth),
    eye: [amount(finite(motion.blinkL) * gain("blink")), amount(finite(motion.blinkR) * gain("blink")),
      amount(finite(motion.eyeWideL) * gain("expression")), amount(finite(motion.eyeWideR) * gain("expression"))],
    gaze: [clamp(finite(motion.lookX) * gain("expression"), -1, 1), clamp(finite(motion.lookY) * gain("expression"), -1, 1)],
    expression: [amount(finite(motion.mouth) * gain("mouth")), amount(finite(motion.smile) * gain("expression")),
      amount(finite(motion.frown) * gain("expression")), amount(finite(motion.pucker) * gain("expression"))],
    mouthX: clamp(finite(motion.mouthX) * gain("expression"), -1, 1),
  };
}

/** Public: the shader's monotonic, compact-support inverse compression curve. */
export function compactWarpCoordinate(value, strength) {
  value = finite(value);
  strength = clamp(finite(strength), -.3, 2.35);
  if (Math.abs(value) >= 1) return value;
  return value + strength * value * (1 - Math.abs(value)) ** 2;
}

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  // Top-origin coordinates agree with HTML images and the source-pixel rig.
  v_uv = a_position * vec2(0.5, -0.5) + vec2(0.5);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec4 u_leftEye;
uniform vec4 u_rightEye;
uniform vec4 u_mouth;
uniform vec4 u_eye;
uniform vec2 u_gaze;
uniform vec4 u_expression;
uniform float u_mouthX;

float bell(float x) {
  float inner = max(0.0, 1.0 - x * x);
  return inner * inner;
}
float compress(float x, float strength) {
  float edge = max(0.0, 1.0 - abs(x));
  // For strength <=2.35 the derivative stays positive: no fold or extra eye.
  return x + strength * x * edge * edge;
}
vec2 eyeWarp(vec2 uv, vec4 box, float blink, float wide) {
  if (box.z <= 0.0 || box.w <= 0.0) return uv;
  vec2 radius = box.zw * vec2(0.66, 0.9);
  vec2 local = (uv - box.xy) / radius;
  if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) return uv;
  float horizontal = bell(local.x);
  float influence = horizontal * bell(local.y);
  float strength = clamp(blink * 2.35 - wide * 0.2, -0.2, 2.35) * horizontal;
  uv.y = box.y + compress(local.y, strength) * radius.y;
  // A tiny displacement of existing pixels; never paint a second iris/lid.
  uv -= u_gaze * box.zw * vec2(0.022, -0.025) * influence * (1.0 - blink);
  return uv;
}
vec2 mouthWarp(vec2 uv) {
  if (u_mouth.z <= 0.0 || u_mouth.w <= 0.0) return uv;
  vec2 radius = u_mouth.zw * vec2(0.85, 0.95);
  vec2 local = (uv - u_mouth.xy) / radius;
  if (abs(local.x) >= 1.0 || abs(local.y) >= 1.0) return uv;
  float influence = bell(local.x) * bell(local.y);
  float widthChange = u_expression.w * 0.3 - u_expression.y * 0.17;
  uv.x = u_mouth.x + compress(local.x, widthChange * bell(local.y)) * radius.x;
  uv.x -= u_mouthX * u_mouth.z * 0.035 * influence;
  // A photograph cannot reveal unseen teeth: only stretch the original mouth.
  uv.y = u_mouth.y + compress(local.y, -u_expression.x * 0.26 * bell(local.x)) * radius.y;
  uv.y += (u_expression.y - u_expression.z) * u_mouth.w * 0.13 * local.x * local.x * influence;
  return uv;
}
void main() {
  vec2 uv = eyeWarp(v_uv, u_leftEye, u_eye.x, u_eye.z);
  uv = eyeWarp(uv, u_rightEye, u_eye.y, u_eye.w);
  uv = mouthWarp(uv);
  gl_FragColor = texture2D(u_image, clamp(uv, vec2(0.0), vec2(1.0)));
}`;

/**
 * Public: local, optional WebGL portrait deformation. No main-canvas access,
 * network requests, flat-skin patches, or invented facial details.
 */
export class PortraitWarp {
  /** Public: create an isolated renderer; actual GPU allocation is lazy. */
  constructor() {
    this.canvas = typeof document === "undefined" ? null : document.createElement("canvas");
    this._source = null;
    this._gl = null;
    this._program = null;
    this._buffer = null;
    this._texture = null;
    this._image = null;
    this._failedImage = null;
    this._lost = false;
    this._disposed = false;
    this._unavailable = false;
    this._onLost = (event) => { event.preventDefault(); this._lost = true; this._image = null; };
    this._onRestored = () => {
      this._lost = false;
      this._unavailable = false;
      this._program = this._buffer = this._texture = this._image = this._failedImage = null;
    };
    this.canvas?.addEventListener("webglcontextlost", this._onLost);
    this.canvas?.addEventListener("webglcontextrestored", this._onRestored);
  }

  _initialize() {
    if (this._program) return true;
    const gl = this._gl || this.canvas.getContext("webgl", {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
    });
    if (!gl) return false;
    this._gl = gl;
    const shaders = [];
    let program = null;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Portrait shader unavailable");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Portrait shader unsupported");
      }
      program = gl.createProgram();
      if (!program) throw new Error("Portrait program unavailable");
      shaders.forEach((shader) => gl.attachShader(program, shader));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Portrait program unsupported");
      this._program = program;
      this._buffer = gl.createBuffer();
      this._texture = gl.createTexture();
      if (!this._buffer || !this._texture) throw new Error("Portrait GPU resources unavailable");
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // Premultiplied interpolation keeps transparent hair edges free of halos.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      this._uniforms = Object.fromEntries(["image", "leftEye", "rightEye", "mouth", "eye", "gaze", "expression", "mouthX"]
        .map((name) => [name, gl.getUniformLocation(program, `u_${name}`)]));
      gl.uniform1i(this._uniforms.image, 0);
      return true;
    } catch {
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._texture) gl.deleteTexture(this._texture);
      if (program) {
        shaders.forEach((shader) => gl.detachShader(program, shader));
        gl.deleteProgram(program);
        program = null;
      }
      this._program = this._buffer = this._texture = null;
      return false;
    } finally {
      shaders.forEach((shader) => { if (program) gl.detachShader(program, shader); gl.deleteShader(shader); });
    }
  }

  /**
   * Public: return an at-most-1024px canvas, or null to draw the original image.
   * Rig boxes are ORIGINAL image pixels. Intensity contains blink/mouth/expression
   * multipliers. Only a new image identity/dimensions causes a texture upload.
   */
  render(image, rig, motion, intensity) {
    if (!this.canvas || this._disposed || this._unavailable || this._lost || !image || this._failedImage === image) return null;
    const width = typeof image.naturalWidth === "number" ? image.naturalWidth : image.width;
    const height = typeof image.naturalHeight === "number" ? image.naturalHeight : image.height;
    const state = portraitWarpState(width, height, rig, motion, intensity);
    if (!state || (!state.leftEye[2] && !state.rightEye[2] && !state.mouth[2])) return null;
    try {
      if (!this._initialize()) { this._unavailable = true; return null; }
      const gl = this._gl;
      if (gl.isContextLost()) return null;
      if (image !== this._image || width !== this._width || height !== this._height) {
        const edge = Math.min(1024, gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const scale = Math.min(1, edge / Math.max(width, height));
        this.canvas.width = Math.max(1, Math.round(width * scale));
        this.canvas.height = Math.max(1, Math.round(height * scale));
        this._source ||= document.createElement("canvas");
        this._source.width = this.canvas.width;
        this._source.height = this.canvas.height;
        const sourceContext = this._source.getContext("2d");
        if (!sourceContext) return null;
        sourceContext.clearRect(0, 0, this._source.width, this._source.height);
        sourceContext.drawImage(image, 0, 0, this._source.width, this._source.height);
        gl.bindTexture(gl.TEXTURE_2D, this._texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._source);
        if (gl.getError() !== gl.NO_ERROR) { this._failedImage = image; return null; }
        this._image = image;
        this._width = width;
        this._height = height;
      }
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this._program);
      for (const name of ["leftEye", "rightEye", "mouth", "eye", "expression"]) gl.uniform4fv(this._uniforms[name], state[name]);
      gl.uniform2fv(this._uniforms.gaze, state.gaze);
      gl.uniform1f(this._uniforms.mouthX, state.mouthX);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return this.canvas;
    } catch {
      // Unsupported images, cross-origin taint or a lost context keep 2D usable.
      this._failedImage = image;
      return null;
    }
  }

  /** Public: release all GPU objects, canvases and listeners; safe to call twice. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.canvas?.removeEventListener("webglcontextlost", this._onLost);
    this.canvas?.removeEventListener("webglcontextrestored", this._onRestored);
    const gl = this._gl;
    if (gl) {
      if (this._texture) gl.deleteTexture(this._texture);
      if (this._buffer) gl.deleteBuffer(this._buffer);
      if (this._program) gl.deleteProgram(this._program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    if (this._source) this._source.width = this._source.height = 1;
    this._gl = this._program = this._buffer = this._texture = this._source = this._image = this._failedImage = null;
    this._uniforms = null;
  }
}
