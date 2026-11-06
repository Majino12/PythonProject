// Classic worker intentionally: the pinned MediaPipe WASM loader uses
// importScripts. Its ES-module wrappers can still be loaded via dynamic import.
const handler=Promise.all([import('./short-hair-face-tracker.js'),import('./short-hair-face-worker-runtime.js')])
  .then(([loader,runtime])=>runtime.createFaceWorkerHandler({loadTracker:loader.loadFaceTracker,postMessage:message=>self.postMessage(message)}));
self.onmessage=async event=>{
  try{await (await handler)(event.data);}
  catch(error){event.data?.bitmap?.close();self.postMessage({type:'error',id:event.data?.id,message:error?.message||'后台识别载入失败。'});}
};
