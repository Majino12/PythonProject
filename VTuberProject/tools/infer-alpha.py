"""Tensor-only offline inference; image decoding/encoding belongs to prepare-alpha.mjs.

Requires numpy and onnxruntime. No image is uploaded and no source image is changed.
The ONNX graph is the author's pinned anime-seg ISNet model, not arbitrary pickle code.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--input', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
inputs = np.fromfile(args.input, dtype='<f4')
if inputs.size != 3 * 1024 * 1024 or not np.isfinite(inputs).all():
    raise ValueError('Expected finite RGB NCHW 1×3×1024×1024 tensor')
options = ort.SessionOptions()
options.intra_op_num_threads = 4
options.inter_op_num_threads = 1
session = ort.InferenceSession(args.model, sess_options=options, providers=['CPUExecutionProvider'])
started = time.monotonic()
prediction = session.run(None, {'img': inputs.reshape(1, 3, 1024, 1024)})[0]
if prediction.shape != (1, 1, 1024, 1024) or not np.isfinite(prediction).all():
    raise ValueError('Unexpected segmentation result')
np.asarray(prediction, dtype='<f4').tofile(args.output)
print(json.dumps({'provider': 'CPUExecutionProvider', 'inferenceMs': round((time.monotonic() - started) * 1000),
                  'onnxruntime': ort.__version__, 'shape': list(prediction.shape)}))
