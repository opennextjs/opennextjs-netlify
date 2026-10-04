// The adapter manifest written at build time and what the runtime derives from it once at startup:
// which output a routable pathname leads to, and how prerenders group.
import type { AdapterManifestComputeOutput } from '../../config.js'
import { getAdapterManifest } from '../../config.js'

// Read the adapter manifest written at build time
async function loadManifest() {
  try {
    return await getAdapterManifest()
  } catch (error) {
    console.error('Failed to load adapter manifest', error)
    throw error
  }
}
export const manifest = await loadManifest()

export type InvokeHandlerArg = {
  id: string
  entrypoint: string
  runtime: 'nodejs' | 'edge'
  sourcePage: string
}

export type StaticFileHandlerArg = {
  filePath: string
  pathname: string
}

// what a routable pathname leads to: a compute output to invoke, or a static file to serve
export type RoutedOutput =
  | { kind: 'compute'; output: InvokeHandlerArg }
  | { kind: 'static'; file: StaticFileHandlerArg }

// `@next/routing` resolves requests to the routing config's pathnames as given, so they double as
// output keys
export const outputsByPathname = new Map<string, RoutedOutput>()
// prerenders render through their parent compute output
export const computeOutputsById = new Map<string, InvokeHandlerArg>()
export const basePath = manifest.config.basePath || ''

// pages/app pages that are prerendered or fully static: those answer reads only, see readOnlyPathnames
const staticPageOutputIds = new Set(
  [...manifest.outputs.pages, ...manifest.outputs.appPages].map((output) => output.id),
)
export const readOnlyPathnames = new Set<string>()

// pages with getStaticProps: prerenders point back at them, their data-route outputs share the
// sourcePage
const ssgParentIds = new Set(manifest.outputs.prerenders.map((output) => output.parentOutputId))
const ssgSourcePages = new Set(
  manifest.outputs.pages
    .filter((output) => ssgParentIds.has(output.id))
    .map((output) => output.sourcePage),
)
export const ssgPathnames = new Set<string>()

// outputs that invoke compute (the runtime manifest is minimized, output types come from the list)
for (const outputs of [
  manifest.outputs.pages,
  manifest.outputs.pagesApi,
  manifest.outputs.appPages,
  manifest.outputs.appRoutes,
]) {
  for (const output of outputs) {
    registerComputeOutput(output)
  }
}

function registerComputeOutput(output: AdapterManifestComputeOutput) {
  const computeOutput = {
    id: output.id,
    entrypoint: output.filePath,
    runtime: output.runtime,
    sourcePage: output.sourcePage,
  }
  computeOutputsById.set(output.id, computeOutput)
  outputsByPathname.set(output.pathname, { kind: 'compute', output: computeOutput })
  if (ssgSourcePages.has(output.sourcePage)) {
    ssgPathnames.add(output.pathname)
  }
}

for (const output of manifest.outputs.prerenders) {
  const parent = computeOutputsById.get(output.parentOutputId)
  if (!parent) {
    throw new Error(
      `Prerender output ${output.id} has parentOutputId ${output.parentOutputId} which does not exist`,
    )
  }
  // params come from the route a prerender renders: `/en/posts/[slug]` may be a shell of
  // `/[locale]/posts/[slug]`
  outputsByPathname.set(output.pathname, { kind: 'compute', output: parent })
  if (staticPageOutputIds.has(output.parentOutputId)) {
    readOnlyPathnames.add(output.pathname)
  }
  ssgPathnames.add(output.pathname)
}

// Prerender groups (adapter output `groupId`): one blob holds every variant of a prerendered path,
// they are regenerated and stored together (see copyPrerenderGroups)
export type PrerenderOutput = (typeof manifest.outputs.prerenders)[number]
export type PrerenderGroup = { entry?: PrerenderOutput; members: PrerenderOutput[] }
export const prerendersByPathname = new Map<string, PrerenderOutput>()
export const prerenderGroups = new Map<number, PrerenderGroup>()
for (const output of manifest.outputs.prerenders) {
  prerendersByPathname.set(output.pathname, output)
  const group = prerenderGroups.get(output.groupId) ?? { members: [] }
  group.members.push(output)
  if (output.isGroupEntry) {
    group.entry = output
  }
  prerenderGroups.set(output.groupId, group)
}

// `public/` files live on the CDN, so a direct request never reaches the function — but a rewrite
// resolved here does, and then the file has to be fetched from the CDN like any other static output
for (const pathname of manifest.publicPathnames) {
  outputsByPathname.set(pathname, {
    kind: 'static',
    file: { filePath: `public${pathname.slice(basePath.length)}`, pathname },
  })
}

for (const output of manifest.outputs.staticFiles) {
  readOnlyPathnames.add(output.pathname)
  outputsByPathname.set(output.pathname, {
    kind: 'static',
    file: { filePath: output.filePath, pathname: output.pathname },
  })
}
