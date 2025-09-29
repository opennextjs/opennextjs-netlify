import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
export const PLUGIN_DIR = join(MODULE_DIR, '../../..')

const packageJSON = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf-8'))

export const GENERATOR = `${packageJSON.name}@${packageJSON.version}`

export const NETLIFY_FRAMEWORKS_API_CONFIG_PATH = '.netlify/v1/config.json'
export const NETLIFY_FRAMEWORKS_API_EDGE_FUNCTIONS = '.netlify/v1/edge-functions'
export const NETLIFY_FRAMEWORKS_API_FUNCTIONS = '.netlify/v1/functions'
export const NEXT_RUNTIME_STATIC_ASSETS = '.netlify/static'

export const DISPLAY_NAME_MIDDLEWARE = 'Next.js Middleware Handler'
export const DISPLAY_NAME_PAGES_AND_APP = 'Next.js Pages and App Router Handler'
