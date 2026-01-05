import { NextResponse } from 'next/server'

import type { ElementHandlers } from './html-rewriter'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NextDataTransform = <T extends { pageProps?: Record<string, any> }>(props: T) => T

// A NextResponse that wraps the Netlify origin response
// We can't pass it through directly, because Next disallows returning a response body
export class MiddlewareResponse extends NextResponse {
  private readonly dataTransforms: NextDataTransform[]
  private readonly elementHandlers: Array<[selector: string, handlers: ElementHandlers]>

  constructor(
    public originResponse: Response,
    init?: ResponseInit,
  ) {
    // we need to propagate the set-cookie header, so response.cookies.get works correctly
    const initHeaders = new Headers()
    if (originResponse.headers.has('set-cookie')) {
      initHeaders.set('set-cookie', originResponse.headers.get('set-cookie'))
    }

    super(undefined, {
      headers: initHeaders,
    })

    if (init?.headers) {
      Object.entries(init.headers).forEach(([key, value]) => {
        this.headers.set(key, value)
      })
    }

    // These are private in Node when compiling, but we access them in Deno at runtime
    Object.defineProperty(this, 'dataTransforms', {
      value: [],
      enumerable: false,
      writable: false,
    })
    Object.defineProperty(this, 'elementHandlers', {
      value: [],
      enumerable: false,
      writable: false,
    })
  }

  /**
   * Transform the page props before they are passed to the client.
   * This works for both HTML pages and JSON data
   */
  transformData(transform: NextDataTransform) {
    // The transforms are evaluated after the middleware is returned
    this.dataTransforms.push(transform)
  }

  /**
   * Rewrite the response HTML with the given selector and handlers
   */
  rewriteHTML(selector: string, handlers: ElementHandlers) {
    this.elementHandlers.push([selector, handlers])
  }

  /**
   * Sets the value of a page prop.
   * @see transformData if you need more control
   */
  setPageProp(key: string, value: unknown) {
    this.transformData((props) => {
      props.pageProps ||= {}
      props.pageProps[key] = value
      return props
    })
  }

  /**
   * Replace the text of the given element. Takes either a string or a function
   * that is passed the original string and returns new new string.
   * @see rewriteHTML for more control
   */
  replaceText(selector: string, valueOrReplacer: string | ((input: string) => string)): void {
    // If it's a string then our job is simpler, because we don't need to collect the current text
    if (typeof valueOrReplacer === 'string') {
      this.rewriteHTML(selector, {
        text(textChunk) {
          if (textChunk.lastInTextNode) {
            textChunk.replace(valueOrReplacer)
          } else {
            textChunk.remove()
          }
        },
      })
    } else {
      let text = ''
      this.rewriteHTML(selector, {
        text(textChunk) {
          text += textChunk.text
          // We're finished, so we can replace the text
          if (textChunk.lastInTextNode) {
            textChunk.replace(valueOrReplacer(text))
          } else {
            // Remove the chunk, because we'll be adding it back later
            textChunk.remove()
          }
        },
      })
    }
  }

  get headers(): Headers {
    // If we have the origin response, we should use its headers
    return this.originResponse?.headers || super.headers
  }

  get status(): number {
    // If we have the origin status, we should use it
    return this.originResponse?.status || super.status
  }
}
