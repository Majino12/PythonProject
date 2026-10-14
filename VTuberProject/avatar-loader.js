const defaultLoaders = {
  studio: () => import("./studio-avatar.js"),
  light: () => import("./avatar3d.js"),
};

function abortError() {
  return new DOMException("模型加载已取消", "AbortError");
}

async function loadOne(canvas, style, loader, { signal, timeoutMs }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(abortError());
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("模型加载超时")), timeoutMs);
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason || abortError());
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const building = (async () => {
    const module = await loader();
    if (controller.signal.aborted) throw controller.signal.reason;
    const avatar = style === "studio"
      ? await module.StudioAvatar3D.create(canvas, { url: "./assets/pixiv-vrm1-sample.vrm", signal: controller.signal })
      : new module.Avatar3D(canvas);
    if (controller.signal.aborted) {
      avatar.dispose();
      throw controller.signal.reason;
    }
    avatar.modelStyle = style;
    return avatar;
  })();
  try { return await Promise.race([building, interrupted]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Load a polished model, or an explicit lightweight fallback, without leaking late results. */
export async function createAvatar3D(canvas, {
  modelStyle = "studio", signal, onProgress = () => {}, timeoutMs = 30000,
} = {}, loaders = defaultLoaders) {
  let fallbackError = null;
  const styles = modelStyle === "light" ? ["light"] : ["studio", "light"];
  for (const style of styles) {
    if (signal?.aborted) throw abortError();
    onProgress(style);
    try {
      const avatar = await loadOne(canvas, style, loaders[style], { signal, timeoutMs });
      avatar.fallbackUsed = Boolean(fallbackError);
      return avatar;
    } catch (error) {
      if (signal?.aborted || style === "light") throw error;
      fallbackError = error;
    }
  }
}
