// Cache-bust: rewrite public/tv.html to reference the bundle by content hash, so a
// new build changes the URL and even a stubborn webOS cache must re-fetch it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const v = createHash('md5').update(readFileSync('tv-bundle.js')).digest('hex').slice(0, 10);
const html = readFileSync('tv.html', 'utf8').replace('tv-bundle.js', `tv-bundle.js?v=${v}`);
writeFileSync('public/tv.html', html);
console.log('bundle ref -> tv-bundle.js?v=' + v);
