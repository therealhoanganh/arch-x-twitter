// Builds the release copy of the plugin into dist/.
//
// A GitHub release delivers only main.js, manifest.json and styles.css, so lib/
// has to travel inside main.js -- otherwise main.js loads lib/archiver.js from a
// folder that was never installed and the plugin dies on load. esbuild bundles
// archiver.js together with the vtt.js and describe.js it requires into a single
// expression assigned to ARCH_LIB, which is prepended to main.js.
//
// main.js's lib() uses ARCH_LIB when it is defined and falls back to loading
// lib/ from disk when it is not, so the repo still runs unbuilt: edit, reload in
// Obsidian, no build step. This script is only needed to cut a release.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'dist';

const result = await build({
  entryPoints: ['lib/index.js'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'ARCH_LIB',
  platform: 'node',
  target: 'es2020',
  // Provided by Obsidian/Electron at runtime. 'obsidian' is listed as a guard:
  // nothing in lib/ may require it -- that module is injected into main.js's
  // scope only -- and this makes a stray require fail loudly at build time
  // rather than silently at load time.
  external: ['obsidian', 'electron', 'path', 'fs', 'os', 'https', 'child_process'],
  legalComments: 'none',
});

const bundled = result.outputFiles[0].text;
const main = await readFile('main.js', 'utf8');

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'main.js'), `'use strict';\n${bundled}\n${main}`);
await copyFile('manifest.json', path.join(OUT, 'manifest.json'));

// styles.css is optional; the manifest does not require one.
try {
  await access('styles.css');
  await copyFile('styles.css', path.join(OUT, 'styles.css'));
} catch {
  /* no stylesheet in this plugin */
}

const size = (await readFile(path.join(OUT, 'main.js'))).length;
console.log(`dist/main.js  ${(size / 1024).toFixed(1)} KB`);
console.log('dist/manifest.json');
