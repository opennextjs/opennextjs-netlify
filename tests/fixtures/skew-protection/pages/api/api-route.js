export default function handler(_req, res) {
  res.send(process.env.SKEW_VARIANT)
}
