import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import argparse
import numpy as np
CODE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--model-directory',type=Path,required=True)
args=parser.parse_args()
ROOT=args.model_directory.resolve()
spec=importlib.util.spec_from_file_location('compiler425',CODE/'compile-rife425-fields.py')
compiler=importlib.util.module_from_spec(spec);spec.loader.exec_module(compiler)

class TrustedCompilerTests(unittest.TestCase):
 def test_reviewed_files_verify(self):compiler.validate_model_files(ROOT)
 def test_any_changed_checkpoint_or_code_is_refused_before_execution(self):
  for relative in compiler.MODEL_HASHES:
   with self.subTest(file=relative),tempfile.TemporaryDirectory(dir=ROOT,prefix='integrity-test-') as d:
    p=Path(d)
    for name in compiler.MODEL_HASHES:
     q=p/name;q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,q)
    q=p/relative;data=bytearray(q.read_bytes());data[len(data)//2]^=1;q.write_bytes(data)
    with self.assertRaisesRegex(ValueError,'expected pinned official'):compiler.Rife425(p)
 def test_candidate_builder_refuses_writing_inside_source_project(self):
  with tempfile.TemporaryDirectory(dir=ROOT,prefix='project-test-') as d:
   with self.assertRaisesRegex(ValueError,'outside the project'):
    compiler.compile_fields(Path(d),ROOT,Path(d)/'assets/replace')
 def test_protocol_stays_float16_four_uv_channels_and_r8_mask(self):
  flow=np.zeros((4,720,576),np.float32);flow[0]=5.76;flow[1]=-7.2
  f,m=compiler.encode_fields({'flow':flow,'mask':np.full((1,720,576),.5,np.float32)})
  self.assertEqual(f.shape,(180,144,4));self.assertEqual(f.dtype,np.dtype('<f2'))
  self.assertEqual(m.shape,(180,144));self.assertEqual(m.dtype,np.dtype('uint8'))
  self.assertAlmostEqual(float(f[20,20,0]),.01,places=5);self.assertAlmostEqual(float(f[20,20,1]),-.01,places=5)
  self.assertTrue(np.all(m==128))
 def test_small_real_inference_exposes_bounded_finite_outputs(self):
  model=compiler.Rife425(ROOT);a=np.full((3,64,64),.2,np.float32);b=np.full((3,64,64),.8,np.float32)
  result=model.infer(a,b,.5)
  self.assertEqual(result['flow'].shape,(4,64,64));self.assertEqual(result['mask'].shape,(1,64,64));self.assertEqual(result['rgb'].shape,(3,64,64))
  self.assertTrue(all(np.isfinite(v).all() for v in result.values()))
  self.assertGreaterEqual(result['mask'].min(),0);self.assertLessEqual(result['mask'].max(),1)
  with self.assertRaises(ValueError):model.infer(a,b,0)
  a[0,0,0]=np.nan
  with self.assertRaises(ValueError):model.infer(a,b,.5)

if __name__=='__main__':unittest.main(argv=[__file__],verbosity=2)
