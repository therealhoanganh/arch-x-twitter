// Single entry point for the bundle. build.mjs turns this into ARCH_LIB; main.js
// falls back to requiring lib/ from disk when ARCH_LIB is undefined, which keeps
// the repo runnable unbuilt.
module.exports = {
  ...require('./naming.js'),
  ...require('./gallerydl.js'),
  ...require('./render.js'),
  // Renderer-only: uses OffscreenCanvas, so requiring it from plain Node is
  // fine but calling encodeWebp there is not.
  ...require('./image.js'),
};
