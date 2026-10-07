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
 * PPR composed in the routing edge function: it asks for a page's shell with this request header
 * (stripped from incoming requests, and part of the CDN cache key so the shell is cached on its
 * own), and the server handler answers with the postponed state followed by the shell, the state's
 * byte length in `POSTPONED_LENGTH_HEADER`.
 */
export const PPR_SHELL_HEADER = 'x-next-ppr-shell'
export const POSTPONED_LENGTH_HEADER = 'x-next-postponed-length'
