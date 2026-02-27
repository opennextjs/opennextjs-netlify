// Re-export from @next/routing to isolate CJS bundling.
//
// @next/routing is a CJS package. When esbuild bundles it into an ESM file, it
// injects a `require()` shim. If that same file also uses top-level `await`,
// Node.js fails with "Cannot determine intended module format" because it sees
// both `require()` and top-level `await`.
//
// By isolating the import in its own module, esbuild produces a separate chunk
// for the CJS require shim. Modules that import from this file get a clean ESM
// import and can safely use top-level `await`.
//
// See also: docs/architecture.md "CJS isolation pattern"
export { resolveRoutes } from 'next-routing'
export type {
  ResolveRoutesParams,
  ResolveRoutesResult,
  MiddlewareContext,
  MiddlewareResult,
} from 'next-routing'
