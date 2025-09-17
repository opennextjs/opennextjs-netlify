import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Span } from '@opentelemetry/api'

import type { PluginContext } from './plugin-context.js'

// eslint-disable-next-line no-shadow
const enum EnabledOrDisabledReason {
  OPT_OUT_DEFAULT = 'off-default',
  OPT_OUT_NO_VALID_DEPLOY_ID = 'off-no-valid-deploy-id',
  OPT_OUT_NO_VALID_DEPLOY_ID_ENV_VAR = 'off-no-valid-deploy-id-env-var',
  OPT_IN_FF = 'on-ff',
  OPT_IN_ENV_VAR = 'on-env-var',
  OPT_OUT_ENV_VAR = 'off-env-var',
}

const optInOptions = new Set([
  EnabledOrDisabledReason.OPT_IN_FF,
  EnabledOrDisabledReason.OPT_IN_ENV_VAR,
])

export function shouldEnableSkewProtection(ctx: PluginContext) {
  let enabledOrDisabledReason: EnabledOrDisabledReason = EnabledOrDisabledReason.OPT_OUT_DEFAULT

  if (
    process.env.NETLIFY_NEXT_SKEW_PROTECTION === 'true' ||
    process.env.NETLIFY_NEXT_SKEW_PROTECTION === '1'
  ) {
    enabledOrDisabledReason = EnabledOrDisabledReason.OPT_IN_ENV_VAR
  } else if (
    process.env.NETLIFY_NEXT_SKEW_PROTECTION === 'false' ||
    process.env.NETLIFY_NEXT_SKEW_PROTECTION === '0'
  ) {
    enabledOrDisabledReason = EnabledOrDisabledReason.OPT_OUT_ENV_VAR
  } else if (ctx.featureFlags?.['next-runtime-skew-protection']) {
    enabledOrDisabledReason = EnabledOrDisabledReason.OPT_IN_FF
  }

  if (
    (!process.env.DEPLOY_ID || process.env.DEPLOY_ID === '0') &&
    optInOptions.has(enabledOrDisabledReason)
  ) {
    // We can't proceed without a valid DEPLOY_ID, because Next.js does inline deploy ID at build time
    // This should only be the case for CLI deploys
    enabledOrDisabledReason =
      enabledOrDisabledReason === EnabledOrDisabledReason.OPT_IN_ENV_VAR && ctx.constants.IS_LOCAL
        ? // this case is singled out to provide visible feedback to users that env var has no effect
          EnabledOrDisabledReason.OPT_OUT_NO_VALID_DEPLOY_ID_ENV_VAR
        : // this is silent disablement to avoid spam logs for users opted in via feature flag
          // that don't explicitly opt in via env var
          EnabledOrDisabledReason.OPT_OUT_NO_VALID_DEPLOY_ID
  }

  return {
    enabled: optInOptions.has(enabledOrDisabledReason),
    enabledOrDisabledReason,
  }
}

export const setSkewProtection = async (ctx: PluginContext, span: Span) => {
  const { enabled, enabledOrDisabledReason } = shouldEnableSkewProtection(ctx)

  span.setAttribute('skewProtection', enabledOrDisabledReason)

  if (!enabled) {
    if (enabledOrDisabledReason === EnabledOrDisabledReason.OPT_OUT_NO_VALID_DEPLOY_ID_ENV_VAR) {
      console.warn(
        `NETLIFY_NEXT_SKEW_PROTECTION environment variable is set to ${process.env.NETLIFY_NEXT_SKEW_PROTECTION}, but skew protection is currently unavailable for CLI deploys. Skew protection will not be enabled.`,
      )
    }
    return
  }

  if (enabledOrDisabledReason === EnabledOrDisabledReason.OPT_IN_ENV_VAR) {
    console.log(
      `Setting up Next.js Skew Protection due to NETLIFY_NEXT_SKEW_PROTECTION=${process.env.NETLIFY_NEXT_SKEW_PROTECTION} environment variable.`,
    )
  } else {
    console.log('Setting up Next.js Skew Protection.')
  }

  process.env.NEXT_DEPLOYMENT_ID = process.env.DEPLOY_ID

  await mkdir(dirname(ctx.skewProtectionConfigPath), {
    recursive: true,
  })
  await writeFile(
    ctx.skewProtectionConfigPath,
    JSON.stringify(
      {
        patterns: ['.*'],
        sources: [
          {
            type: 'cookie',
            name: '__vdpl',
          },
          {
            type: 'header',
            name: 'X-Deployment-Id',
          },
          {
            type: 'query',
            name: 'dpl',
          },
        ],
      },
      null,
      2,
    ),
  )
}
