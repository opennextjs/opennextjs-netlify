/**
 * Skew Protection Edge Function for Next.js on Netlify
 * 
 * This function implements Next.js skew protection by:
 * 1. Checking for deployment ID in query param (?dpl=<id>), header (X-Deployment-Id), or cookie (__vdpl)
 * 2. Routing requests to the appropriate deployment
 * 
 * Note: Next.js automatically sets the __vdpl cookie when VERCEL_SKEW_PROTECTION_ENABLED=1,
 * so this edge function only needs to handle the routing logic.
 */

const SKEW_PROTECTION_COOKIE = '__vdpl'
const DEPLOYMENT_ID_HEADER = 'X-Deployment-Id'
const DEPLOYMENT_ID_QUERY_PARAM = 'dpl'

export default async (request, context) => {
  const url = new URL(request.url)
  const currentDeployId = context.deploy?.id

  // Skip in dev mode
  if (!currentDeployId) {
    return
  }

  // Get deployment ID from request in priority order:
  // 1. Query parameter (?dpl=<id>)
  // 2. Header (X-Deployment-Id)  
  // 3. Cookie (__vdpl)
  let requestedDeployId = url.searchParams.get(DEPLOYMENT_ID_QUERY_PARAM)
  
  if (!requestedDeployId) {
    requestedDeployId = request.headers.get(DEPLOYMENT_ID_HEADER)
  }
  
  if (!requestedDeployId) {
    const cookies = request.headers.get('cookie')
    if (cookies) {
      const cookieMatch = cookies.match(new RegExp(`${SKEW_PROTECTION_COOKIE}=([^;]+)`))
      requestedDeployId = cookieMatch?.[1]
    }
  }

  // If no deployment ID is specified or it matches current deployment, continue normally
  if (!requestedDeployId || requestedDeployId === currentDeployId) {
    return
  }

  // Route to the requested deployment
  try {
    const targetUrl = new URL(request.url)
    
    // Check if this is a request that should be routed to old deployment
    if (shouldRouteToOldDeployment(url.pathname)) {
      // Route to the old deployment by changing the hostname
      targetUrl.hostname = `${requestedDeployId}--${context.site.name}.netlify.app`
      
      // Remove the dpl query parameter to avoid infinite loops
      targetUrl.searchParams.delete(DEPLOYMENT_ID_QUERY_PARAM)
      
      // Create new request with the updated URL, preserving all headers
      const newRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      })
      
      // Remove the deployment ID header to avoid confusion
      newRequest.headers.delete(DEPLOYMENT_ID_HEADER)
      
      console.log(`[Skew Protection] Routing ${url.pathname} to deployment ${requestedDeployId}`)
      return fetch(newRequest)
    }
  } catch (error) {
    console.error('[Skew Protection] Error routing to old deployment:', error)
    // Fall through to continue with current deployment
  }

  // For other requests, continue with current deployment
}

function shouldRouteToOldDeployment(pathname) {
  // Route static assets and API routes to old deployments
  // But not HTML pages (those should use current deployment for skew protection)
  
  // Static assets (JS, CSS, images, etc.)
  if (/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|webp|avif)$/.test(pathname)) {
    return true
  }
  
  // Next.js static assets
  if (pathname.startsWith('/_next/static/')) {
    return true
  }
  
  // API routes
  if (pathname.startsWith('/api/')) {
    return true
  }
  
  // Server actions and chunks
  if (pathname.includes('/_next/static/chunks/')) {
    return true
  }
  
  // Image optimization
  if (pathname.startsWith('/_next/image')) {
    return true
  }
  
  // Don't route HTML pages - they should use current deployment
  return false
}

export const config = {
  path: "/*"
}