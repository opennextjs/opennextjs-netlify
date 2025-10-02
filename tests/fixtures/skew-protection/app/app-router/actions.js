'use server'

export async function testAction() {
  return process.env.SKEW_VARIANT
}
