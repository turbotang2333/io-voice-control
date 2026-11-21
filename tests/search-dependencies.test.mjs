import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDependencyPaths } from '../distribution/search-dependencies.mjs';

test('only search-exclusive dependencies are omitted from the light package', () => {
  const lock = { packages: {
    '': { dependencies: { '@huggingface/transformers': '1', qrcode: '1' } },
    'node_modules/@huggingface/transformers': { dependencies: { onnx: '1', shared: '1', tar: '1' } },
    'node_modules/onnx': {}, 'node_modules/shared': {}, 'node_modules/qrcode': { dependencies: { shared: '1' } },
    'node_modules/tar': { dependencies: { small: '1' } }, 'node_modules/small': {},
  } };
  assert.deepEqual([...searchDependencyPaths(lock)].sort(), ['node_modules/@huggingface/transformers', 'node_modules/onnx']);
});
