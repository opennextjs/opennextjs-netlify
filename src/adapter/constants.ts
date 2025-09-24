import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
export const PLUGIN_DIR = join(MODULE_DIR, '../..')

const packageJSON = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf-8'))

export const GENERATOR = `${packageJSON.name}@${packageJSON.version}`
