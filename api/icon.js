import { ICONS } from './_icons.js';
export default function handler(req, res) {
  const f = ICONS[String(req.query.f || '')];
  if (!f) return res.status(404).send('Not found');
  res.setHeader('Content-Type', f.type);
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  return res.status(200).send(Buffer.from(f.b64, 'base64'));
}
