export const GET = async (req) => {
  return new Response(process.env.SKEW_VARIANT)
}
