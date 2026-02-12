import assert from 'node:assert';
import { spawn } from '../dist/index.mjs';

const subprocess = spawn('node', ['-e', "console.log('node20-ok')"]);
const result = await subprocess;

assert.ok(result.output.includes('node20-ok'), `Unexpected output: ${result.output}`);
assert.strictEqual(result.exitCode, 0);
