/** No model/WASM requests until this function is explicitly called. Shared by
 * the worker and the main-thread compatibility path, with the same pinned model. */
export async function loadFaceTracker({delegate='GPU'}={}) {
  const {FaceLandmarker,FilesetResolver}=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
  const fileset=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
  const options={baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',delegate},
    numFaces:1,outputFaceBlendshapes:true,outputFacialTransformationMatrixes:true,runningMode:'VIDEO',
    minFaceDetectionConfidence:.35,minFacePresenceConfidence:.35,minTrackingConfidence:.35};
  try{return await FaceLandmarker.createFromOptions(fileset,options);}
  catch(error){if(delegate==='CPU')throw error;return FaceLandmarker.createFromOptions(fileset,{...options,baseOptions:{...options.baseOptions,delegate:'CPU'}});}
}
