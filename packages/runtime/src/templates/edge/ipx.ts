import { getHandler } from 'https://ipx-edge-function-layer.netlify.app/mod.ts'

import imageconfig from './imageconfig.json' with { type: 'json' }

export default getHandler({ formats: imageconfig?.formats })
