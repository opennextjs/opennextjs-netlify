import { assertEquals, assertExists, assertStringIncludes } from 'https://deno.land/std@0.175.0/testing/asserts.ts'
import { HTMLRewriter } from '../vendor/deno.land/x/htmlrewriter@v1.0.0/src/index.ts'

// Test the lazy initialization module structure
// Note: The source file is generated at plugin build time with actual base64-encoded WASM
// from htmlrewriter@v1.0.0. These tests verify the generated file structure.

Deno.test('html-rewriter-wasm module structure', async (t) => {
  await t.step('should export initHtmlRewriter function', async () => {
    const module = await import('../html-rewriter-wasm.ts')
    assertExists(module.initHtmlRewriter)
    assertEquals(typeof module.initHtmlRewriter, 'function')
  })

  await t.step('generated file should contain base64-encoded WASM data', async () => {
    const fileContent = await Deno.readTextFile(
      new URL('../html-rewriter-wasm.ts', import.meta.url),
    )
    // The generated file should have actual base64 data, not a placeholder
    assertStringIncludes(fileContent, "let wasmBase64: string | null = '")
    // Base64 strings are long - verify it's not empty or a placeholder
    const match = fileContent.match(/let wasmBase64: string \| null = '([^']*)'/)
    assertExists(match)
    // Real WASM base64 should be substantial (the WASM is ~2MB, base64 is ~2.7MB)
    assertEquals(match[1].length > 1000, true, 'WASM base64 should be substantial')
  })

  await t.step('generated file should null out wasmBase64 after use (GC optimization)', async () => {
    const fileContent = await Deno.readTextFile(
      new URL('../html-rewriter-wasm.ts', import.meta.url),
    )
    assertStringIncludes(fileContent, 'wasmBase64 = null')
  })

  await t.step('generated file should have idempotent initialization guard', async () => {
    const fileContent = await Deno.readTextFile(
      new URL('../html-rewriter-wasm.ts', import.meta.url),
    )
    assertStringIncludes(fileContent, 'if (initialized')
  })

  await t.step('generated file should have descriptive header comment', async () => {
    const fileContent = await Deno.readTextFile(
      new URL('../html-rewriter-wasm.ts', import.meta.url),
    )
    assertStringIncludes(fileContent, 'Generated at plugin build time from htmlrewriter@v1.0.0 WASM')
  })
})

Deno.test('HTMLRewriter functionality', async (t) => {
  await t.step('initHtmlRewriter should initialize WASM successfully', async () => {
    const { initHtmlRewriter } = await import('../html-rewriter-wasm.ts')
    // Should not throw
    await initHtmlRewriter()
  })

  await t.step('initHtmlRewriter should be idempotent (safe to call multiple times)', async () => {
    const { initHtmlRewriter } = await import('../html-rewriter-wasm.ts')
    // Should not throw on subsequent calls
    await initHtmlRewriter()
    await initHtmlRewriter()
  })

  await t.step('HTMLRewriter should transform HTML elements', async () => {
    const { initHtmlRewriter } = await import('../html-rewriter-wasm.ts')
    await initHtmlRewriter()

    const html = '<div class="test">Hello</div>'
    const response = new Response(html, {
      headers: { 'content-type': 'text/html' },
    })

    const rewriter = new HTMLRewriter()
    rewriter.on('div', {
      element(element) {
        element.setAttribute('data-transformed', 'true')
      },
    })

    const transformed = rewriter.transform(response)
    const result = await transformed.text()

    assertStringIncludes(result, 'data-transformed="true"')
    assertStringIncludes(result, 'Hello')
  })

  await t.step('HTMLRewriter should transform text content', async () => {
    const { initHtmlRewriter } = await import('../html-rewriter-wasm.ts')
    await initHtmlRewriter()

    const html = '<span>original text</span>'
    const response = new Response(html, {
      headers: { 'content-type': 'text/html' },
    })

    const rewriter = new HTMLRewriter()
    rewriter.on('span', {
      text(text) {
        if (text.text === 'original text') {
          text.replace('modified text')
        }
      },
    })

    const transformed = rewriter.transform(response)
    const result = await transformed.text()

    assertStringIncludes(result, 'modified text')
  })
})
