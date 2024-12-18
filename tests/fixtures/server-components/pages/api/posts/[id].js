export default function handler(req, res) {
  const { id } = req.query
  res.send({ code: 200, message: `okay ${id}` })
}
