// this file isn't meant to be imported.
// it's a list of all external modules that we use,
// and we vendor those into the `vendor/` directory
// for consumption in other files.
// Vendoring happens automatically as part of runtime `build` script.
// You can trigger just vendoring without full package build by running `build:vendor` script.

import 'https://deno.land/std@0.175.0/encoding/base64.ts'
import 'https://deno.land/std@0.175.0/http/cookie.ts'
import 'https://deno.land/std@0.175.0/node/buffer.ts'
import 'https://deno.land/std@0.175.0/node/events.ts'
import 'https://deno.land/std@0.175.0/node/async_hooks.ts'
import 'https://deno.land/std@0.175.0/node/assert.ts'
import 'https://deno.land/std@0.175.0/node/util.ts'
import 'https://deno.land/std@0.175.0/path/mod.ts'

import 'https://deno.land/x/path_to_regexp@v6.2.1/index.ts'
import 'https://deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

import 'https://esm.sh/v91/next@12.2.5/deno/dist/server/web/spec-extension/request.js'
import 'https://esm.sh/v91/next@12.2.5/deno/dist/server/web/spec-extension/response.js'
