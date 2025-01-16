export default async function handler(req, res) {
  await new Promise((resolve) => setTimeout(resolve, 5000))

  res.json({ message: 'ok' })
}
