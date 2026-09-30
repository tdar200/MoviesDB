import { cp, readdir } from 'node:fs/promises';
const source = new URL('../catalog-cache/', import.meta.url);
const files = await readdir(source).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
if (files.length) {
  await cp(source, new URL('../public/catalog-cache/', import.meta.url), { recursive: true });
  console.log(`Hosted ${files.length} complete category snapshots`);
}
