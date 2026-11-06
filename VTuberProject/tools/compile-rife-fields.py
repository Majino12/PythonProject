#!/usr/bin/env python3
"""Offline RIFE v4.6 motion-field compiler; never runs in the browser.

Requires numpy, Pillow, ncnn==1.0.20261020. The two weight files must come
from nihui/rife-ncnn-vulkan commit a7532fc3f9f8f008cd6eecd6f2ffe2a9698e0cf7.
Their bytes are checked before native model parsing. Source art is read only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import ncnn
import numpy as np
from PIL import Image

MODEL_COMMIT = 'a7532fc3f9f8f008cd6eecd6f2ffe2a9698e0cf7'
MODEL_HASHES = {
    'flownet.bin': 'f334ed2260149ce0188a6dcf049844e8b0cdd912e01cbcfb63553157d2508958',
    'flownet.param': '724569596bcd1e7b9fa50455c604777ebed99746d2ef40aa86e31b5725f1053c',
}
TIMES = [i / 8 for i in range(1, 8)]
GRID = [['view-left-up', 'view-up', 'view-right-up'],
        ['view-left', 'front', 'view-right'],
        ['view-left-down', 'view-down', 'view-right-down']]
EDGES = ([(row[x], row[x+1]) for row in GRID for x in range(2)]
         + [(GRID[y][x], GRID[y+1][x]) for y in range(2) for x in range(3)]
         + [(GRID[y][x], GRID[y+1][x+1]) for y in range(2) for x in range(2)])


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def warp(image, flow):
    """CPU bilinear backward sampling, matching upstream src/warp.cpp.

    Coordinates are pixel centres at integers; border sampling is clamped.
    The explicit clamp before fractional weights also follows upstream.
    """
    _, height, width = image.shape
    yy, xx = np.mgrid[:height, :width].astype(np.float32)
    x, y = xx + flow[0], yy + flow[1]
    x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    x1, y1 = np.clip(x0 + 1, 0, width - 1), np.clip(y0 + 1, 0, height - 1)
    x0, y0 = np.clip(x0, 0, width - 1), np.clip(y0, 0, height - 1)
    ax, ay = x - x0, y - y0
    result = ((image[:, y0, x0] * (1-ax) + image[:, y0, x1] * ax) * (1-ay)
              + (image[:, y1, x0] * (1-ax) + image[:, y1, x1] * ax) * ay)
    return np.ascontiguousarray(result, dtype=np.float32)


class Warp(ncnn.Layer):
    def __init__(self):
        super().__init__()
        self.one_blob_only = False
        self.support_inplace = False

    def forward(self, bottom, top, opt):
        result = warp(np.array(bottom[0]), np.array(bottom[1]))
        top[0].clone_from(ncnn.Mat(result), opt.blob_allocator)
        return 0


class Rife:
    def __init__(self, weights, threads=4):
        for name, expected in MODEL_HASHES.items():
            if sha256((weights / name).read_bytes()) != expected:
                raise ValueError(f'{name}: expected pinned official RIFE v4.6 bytes')
        self.layers = []
        self.net = ncnn.Net()
        self.net.opt.use_vulkan_compute = False
        self.net.opt.use_packing_layout = False
        self.net.opt.use_fp16_storage = False
        self.net.opt.use_fp16_arithmetic = False
        self.net.opt.num_threads = threads
        def create():
            layer = Warp()
            self.layers.append(layer)
            return layer
        def destroy(layer):
            if layer in self.layers:
                self.layers.remove(layer)
        if self.net.register_custom_layer('rife.Warp', create, destroy) != 0:
            raise RuntimeError('Cannot register upstream RIFE Warp operation')
        if self.net.load_param(str(weights / 'flownet.param')) != 0:
            raise RuntimeError('Cannot load pinned network parameters')
        if self.net.load_model(str(weights / 'flownet.bin')) != 0:
            raise RuntimeError('Cannot load pinned network weights')

    def infer(self, a, b, t, include_output=False):
        height, width = a.shape[1:]
        padding = ((0, 0), (0, (-height) % 32), (0, (-width) % 32))
        a, b = np.pad(a, padding), np.pad(b, padding)
        tm = np.full((1, a.shape[1], a.shape[2]), t, np.float32)
        with self.net.create_extractor() as ex:
            ex.set_light_mode(False)
            for name, value in [('in0', a), ('in1', b), ('in2', tm)]:
                if ex.input(name, ncnn.Mat(value)) != 0:
                    raise RuntimeError(f'Cannot bind {name}')
            out = {}
            for name in ['327', '332'] + (['out0'] if include_output else []):
                status, value = ex.extract(name)
                if status != 0:
                    raise RuntimeError(f'Cannot extract RIFE blob {name}')
                out[name] = np.array(value).copy()[:, :height, :width]
        if not all(np.isfinite(value).all() for value in out.values()):
            raise RuntimeError('Non-finite RIFE result')
        return out

    def close(self):
        self.net.clear()


def resize_plane(plane, size):
    return np.asarray(Image.fromarray(plane.astype(np.float32)).resize(
        size, Image.Resampling.BILINEAR), dtype=np.float32)


def compile_fields(project, weights, destination, threads):
    pack = json.loads((project / 'assets/short-hair-v1/character-pack.json').read_text())
    references = {record['id']: record['reference']['path'] for record in pack['poses']}
    inputs, source_records = {}, {}
    for pose, relative in references.items():
        path = project / relative
        source_records[pose] = {'path': relative, 'sha256': sha256(path.read_bytes())}
        with Image.open(path) as im:
            if im.size != (1122, 1402):
                raise ValueError(f'{pose}: expected the registered 1122 x 1402 original')
            inputs[pose] = np.asarray(im.convert('RGB').resize((576, 720),
                Image.Resampling.LANCZOS), dtype=np.float32).transpose(2, 0, 1) / 255
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {
        'schemaVersion': 1, 'id': 'short-hair-rife-v4.6-fields-v1',
        'model': {'name': 'RIFE v4.6', 'implementation': 'nihui/rife-ncnn-vulkan',
            'commit': MODEL_COMMIT, 'license': 'MIT', 'weights': MODEL_HASHES,
            'url': f'https://github.com/nihui/rife-ncnn-vulkan/tree/{MODEL_COMMIT}',
            'runtime': f'ncnn {ncnn.__version__}, CPU float32, no TTA',
            'flowBlob': '327', 'maskBlob': '332'},
        'inferenceSize': [576, 720], 'padding': 'right/bottom zero to multiples of 32',
        'fieldSize': [144, 180], 'times': TIMES,
        'flowFormat': 'little-endian float16, [time][y][x][dx0,dy0,dx1,dy1]',
        'flowUnits': 'normalized image UV displacement; positive y points down',
        'maskFormat': 'uint8, [time][y][x], endpoint0 weight / 255',
        'sampling': 'pixel-centred bilinear; fields are downsampled from neural outputs',
        'endpoints': 'source art is used exactly at t=0 and t=1',
        'sources': source_records, 'edges': [],
    }
    model = Rife(weights, threads)
    started = time.monotonic()
    try:
        for first, second in EDGES:
            edge_started = time.monotonic()
            flows, masks, timings = [], [], []
            for t in TIMES:
                before = time.monotonic()
                result = model.infer(inputs[first], inputs[second], t)
                timings.append(time.monotonic()-before)
                flow = np.stack([resize_plane(result['327'][c] / (576 if c % 2 == 0 else 720),
                    (144, 180)) for c in range(4)], axis=-1)
                if not np.isfinite(flow).all() or np.max(np.abs(flow)) > 2:
                    raise RuntimeError('Unusable displacement field')
                mask = resize_plane(result['332'][0], (144, 180))
                flows.append(flow)
                masks.append(np.rint(np.clip(mask, 0, 1)*255).astype(np.uint8))
            prefix = first + '--' + second
            flow_bytes = np.stack(flows).astype('<f2').tobytes(order='C')
            mask_bytes = np.stack(masks).tobytes(order='C')
            flow_name, mask_name = prefix + '.flow.bin', prefix + '.mask.bin'
            (destination / flow_name).write_bytes(flow_bytes)
            (destination / mask_name).write_bytes(mask_bytes)
            record = {'id': first + '__' + second, 'from': first, 'to': second,
                'flow': {'path': flow_name, 'bytes': len(flow_bytes), 'sha256': sha256(flow_bytes)},
                'mask': {'path': mask_name, 'bytes': len(mask_bytes), 'sha256': sha256(mask_bytes)},
                'inferenceSeconds': [round(t, 6) for t in timings]}
            manifest['edges'].append(record)
            print(f'{prefix}: 7 actual model evaluations, {time.monotonic()-edge_started:.2f}s', flush=True)
    finally:
        model.close()
    manifest['compilationSeconds'] = round(time.monotonic()-started, 3)
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'edges': len(EDGES), 'evaluations': len(EDGES)*len(TIMES),
        'seconds': manifest['compilationSeconds'],
        'fieldBytes': sum(e[k]['bytes'] for e in manifest['edges'] for k in ['flow', 'mask'])}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--weights', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--threads', type=int, default=4, choices=range(1, 33))
    args = parser.parse_args()
    compile_fields(args.project.resolve(), args.weights.resolve(),
        (args.output or args.project / 'assets/short-hair-motion-v1').resolve(), args.threads)
