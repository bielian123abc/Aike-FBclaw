// Quick test v2
import { FbClawApp } from './index.js';
import * as fs from 'fs';

fs.writeFileSync('G:/Aike-FBclaw/test-result.txt', 'start\n');
const app = new FbClawApp();
fs.appendFileSync('G:/Aike-FBclaw/test-result.txt', 'created\n');
app.initialize().then(r => {
  fs.appendFileSync('G:/Aike-FBclaw/test-result.txt', r.message + '\n');
  console.log('DONE:', r.message);
}).catch(e => {
  fs.appendFileSync('G:/Aike-FBclaw/test-result.txt', 'ERR: ' + e.message + '\n');
  console.error('ERR:', e.message);
});
