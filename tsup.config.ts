import { defineConfig } from 'tsup';

const CJS_SHIM = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";

export default defineConfig([
  // Library + multi-file build (npm package). dist/ is not committed.
  {
    entry: {
      index: 'src/index.ts',
      'cli/index': 'src/cli/index.ts',
      'mcp/server': 'src/mcp/server.ts',
      'hooks/index': 'src/hooks/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    shims: true,
    target: 'node20',
  },
  // Self-contained single-file bundles (committed under bundle/ so git/marketplace installs work
  // without `npm install`). hook.mjs additionally stays free of zod/gray-matter/MCP SDK (NFR-05).
  {
    entry: {
      agentrunlog: 'src/cli/index.ts',
      hook: 'src/hooks/light-entry.ts',
    },
    outDir: 'bundle',
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    splitting: false,
    dts: false,
    clean: true,
    sourcemap: false,
    minify: true,
    shims: true,
    target: 'node20',
    banner: { js: CJS_SHIM },
  },
]);
