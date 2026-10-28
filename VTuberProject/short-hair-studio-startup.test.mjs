import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = new URL('.', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');

test('the default server route opens the short-hair studio and preserves the old application at an explicit legacy URL', async () => {
  let handle;
  const context = vm.createContext({readFile,stat,extname,join,normalize,fileURLToPath,URL,Buffer,AbortSignal,
    process:{env:{PORT:'0'}},console:{log(){}},createServer(callback){handle=callback;return{listen(){},address:()=>({port:0})};}});
  const source = read('server.mjs').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('server.mjs',root).href));
  vm.runInContext(source,context);
  const request = async path => {
    const result = {};await handle({method:'GET',url:path},{writeHead(status,headers){Object.assign(result,{status,headers});},end(body){result.html=String(body);}});
    return result;
  };
  for (const route of ['/', '/index.html']) {
    const response = await request(route);
    assert.equal(response.status, 200); assert.match(response.html, /url=\.\/short-hair-studio\.html/);
    assert.doesNotMatch(response.html, /app\.js|avatar3d|importmap|preconnect/);
  }
  const studio = await request('/short-hair-studio.html');
  assert.equal(studio.status, 200); assert.match(studio.html, /src="\.\/short-hair-studio\.js"/);
  const legacy = await request('/legacy-studio.html');
  assert.equal(legacy.status, 200); assert.match(legacy.html, /src="app\.js"/);
});

test('studio startup static dependencies are local and exclude legacy, 3D and body tracking modules', () => {
  const pending = ['short-hair-studio.js'], seen = new Set();
  while (pending.length) {
    const name = pending.pop(); if (seen.has(name)) continue; seen.add(name);
    const source = read(name);
    for (const match of source.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?/gm)) {
      assert.ok(match[1].startsWith('./'), `${name} has a non-local startup import: ${match[1]}`);
      pending.push(new URL(match[1], new URL(name, root)).pathname.slice(root.pathname.length));
    }
  }
  for (const old of ['app.js','avatar3d.js','studio-avatar.js','avatar-loader.js','project-store.js']) assert.equal(seen.has(old), false, old);
  assert.ok(seen.has('short-hair-studio-camera.js'));
  assert.doesNotMatch(read('short-hair-studio.html'), /preconnect|importmap|<script[^>]*src=["']https?:/);
  assert.doesNotMatch(read('short-hair-studio-camera.js'), /PoseLandmarker|pose_landmarker/);
});
