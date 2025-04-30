import prerenderManifest from '../edge-shared/prerender-manifest.json' with { type: 'json' }
import { getRscDataRouter, PrerenderManifest } from '../edge-shared/rsc-data.ts'

const handler = getRscDataRouter(prerenderManifest as PrerenderManifest)
export default handler
