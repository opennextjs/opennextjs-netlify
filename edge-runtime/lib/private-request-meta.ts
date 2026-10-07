/**
 * Information our edge function passes to our server handler for the same request, as a JSON
 * `x-next-request-meta` request header. The edge function strips the header from incoming requests
 * and is the only thing that sets it, and `requestID` has to match the platform-generated
 * `x-nf-request-id` the server handler sees. A client can't predict that id, so it can't forge a
 * header the server handler will accept.
 *
 * This lives in the edge runtime because that ships as source and is bundled by Deno at deploy
 * time, so it can only import files copied alongside it. `src` is bundled by esbuild and can
 * import from here, so keep this free of anything Deno and Node don't both have.
 */
export type RequestMeta = {
  requestID: string
  publicUrl?: string
  /** serialized `ResolveRoutesResult`, adapter mode only: routing ran in the edge function */
  routeResolution?: string
}

export const REQUEST_META_HEADER = 'x-next-request-meta'

/**
 * Set by the server handler on its own request for a static output it serves from the CDN (routing
 * already ran for the original request): the routing edge function passes such a request through
 * untouched instead of routing it, and running middleware, a second time.
 * TODO(adapter): a client can set it too and skip routing (and middleware) for a static file; bind
 * it to something a client can't know, like the request meta's request id.
 */
export const STATIC_OUTPUT_FETCH_HEADER = 'x-next-static-output-fetch'
