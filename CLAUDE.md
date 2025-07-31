# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Next.js Runtime for Netlify (@netlify/plugin-nextjs) - a Netlify build plugin that handles the build process and creates the runtime environment for Next.js sites on Netlify. The plugin is automatically used during builds of Next.js sites on Netlify and supports Next.js 13.5+ with Node.js 18+.

## Development Commands

### Build
- `npm run build` - Build the plugin using custom build script
- `npm run build:watch` - Build in watch mode

### Testing
- `npm test` - Run all tests using Vitest
- `npm run test:unit` - Run unit tests only
- `npm run test:integration` - Run integration tests only  
- `npm run test:smoke` - Run smoke tests only
- `npm run test:e2e` - Run E2E tests using Playwright
- `npm run test:ci:unit-and-integration` - CI command for unit + integration tests
- `npm run test:ci:smoke` - CI command for smoke tests
- `npm run test:ci:e2e` - CI command for E2E tests

### Code Quality
- `npm run lint` - Lint TypeScript/JavaScript files with ESLint
- `npm run typecheck` - Type check with TypeScript compiler
- `npm run format:check` - Check code formatting with Prettier
- `npm run format:fix` - Fix code formatting with Prettier

### Test Preparation  
- `npm run pretest:integration` - Builds and prepares test fixtures (runs automatically before tests)

## Architecture

The plugin follows Netlify's build plugin lifecycle with these main entry points in `src/index.ts`:

- **onPreDev** - Cleans up blob files before local development
- **onPreBuild** - Prepares build environment, enables Next.js standalone mode
- **onBuild** - Main build logic, handles static exports vs full builds
- **onPostBuild** - Publishes static assets to CDN
- **onSuccess** - Prewarms deployment URLs
- **onEnd** - Cleanup after build completion

### Key Directories

- **src/build/** - Build-time logic for processing Next.js applications
  - `content/` - Static asset handling, prerendered content processing
  - `functions/` - Edge and server function generation
  - `templates/` - Function handler templates
- **src/run/** - Runtime logic for handling requests 
  - `handlers/` - Cache, request context, server request handlers
  - `storage/` - Blob storage and in-memory cache implementations
- **src/shared/** - Shared types and utilities
- **edge-runtime/** - Edge function runtime environment
- **tests/fixtures/** - Test fixtures for various Next.js configurations

### Plugin Context

The `PluginContext` class (`src/build/plugin-context.ts`) centralizes build configuration and provides access to:
- Build output paths and directories
- Next.js build configuration  
- Netlify deployment context
- Feature flags and environment variables

### Build Process

1. **Static Export**: For `output: 'export'` - copies static files and sets up image handler
2. **Full Build**: Creates server/edge handlers, processes static/prerendered content, configures headers and image CDN

### Skew Protection

When `VERCEL_SKEW_PROTECTION_ENABLED=1` is set, the plugin automatically:

1. **Sets deployment ID**: Maps `NETLIFY_DEPLOY_ID` to `VERCEL_DEPLOYMENT_ID` for Next.js compatibility
2. **Creates edge function**: Generates a skew protection edge function at `___netlify-skew-protection`
3. **Handles routing**: Routes requests with deployment IDs (`?dpl=<id>`, `X-Deployment-Id` header, or `__vdpl` cookie) to appropriate deployments
4. **Asset routing**: Static assets and API routes are routed to old deployments, while HTML pages use current deployment

The edge function is automatically added to the edge functions manifest with highest priority (pattern: `^.*$`).

## Testing

### Test Organization
- **Unit tests**: Individual module testing
- **Integration tests**: End-to-end plugin functionality with real Next.js projects  
- **Smoke tests**: Compatibility testing across Next.js versions
- **E2E tests**: Full deployment scenarios using Playwright

### Important Test Configuration
- Some integration tests run in isolation due to side effects (configured in `vitest.config.ts`)
- Test fixtures in `tests/fixtures/` cover various Next.js configurations
- Custom sequencer handles test sharding for CI

### Test Fixtures
Extensive test fixtures cover scenarios like:
- Middleware configurations
- API routes and edge functions
- Static exports and ISR
- Monorepo setups (Nx, Turborepo)
- Various Next.js features (PPR, image optimization, etc.)

## Environment Variables

- `NETLIFY_NEXT_PLUGIN_SKIP` - Skip plugin execution entirely
- `NEXT_PRIVATE_STANDALONE` - Enabled automatically for builds
- `IS_LOCAL` - Indicates local development vs deployment
- `VERCEL_SKEW_PROTECTION_ENABLED` - Enable Next.js skew protection (set to '1')
- `VERCEL_DEPLOYMENT_ID` - Set automatically from `NETLIFY_DEPLOY_ID` when skew protection is enabled

## Build Tools

- Custom build script at `tools/build.js` handles compilation
- Uses esbuild for fast builds
- Supports watch mode for development