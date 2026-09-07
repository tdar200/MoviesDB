import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange } from './http-range.js';
test('media probes can read suffixes and ranges extending beyond EOF', () => {
 assert.deepEqual(parseByteRange('bytes=-100', 1000), {start:900,end:999});
 assert.deepEqual(parseByteRange('bytes=950-2000', 1000), {start:950,end:999});
 assert.deepEqual(parseByteRange('bytes=0-', 1000), {start:0,end:999});
 assert.deepEqual(parseByteRange('bytes=-2000', 1000), {start:0,end:999});
});
test('invalid or unsatisfiable media ranges return 416', () => {
 for(const input of ['bytes=-0','bytes=-','bytes=1000-','bytes=20-10','bytes=0-1,4-5','bytes=NaN-']) assert.equal(parseByteRange(input,1000),false);
 assert.equal(parseByteRange(undefined,1000),null);
});
