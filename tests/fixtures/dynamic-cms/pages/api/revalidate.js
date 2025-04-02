export default async function handler(req, res) {
  try {
    const pathToPurge = req.query.path ?? '/static/revalidate-manual'
    await res.revalidate(pathToPurge)
    return res.json({ code: 200, message: 'success' })
  } catch (err) {
    return res.status(500).send({ code: 500, message: err.message })
  }
}
