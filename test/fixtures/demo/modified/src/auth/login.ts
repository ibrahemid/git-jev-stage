import { findUser, verify, sign } from "./service";
import { audit } from "./audit";

export async function login(req, res, next) {
  const user = await findUser(req.body.email);
  if (!user || !user.active) return res.status(401).end();
  if (user.lockedUntil && user.lockedUntil > Date.now()) return res.status(423).end();
  const ok = await verify(req.body.password, user.hash);
  if (!ok) return res.status(401).end();
  const token = sign(user);
  res.json({ token });
  next();
}

export async function refresh(req, res) {
  const claims = decode(req.body.token);
  const user = await findUser(claims.email);
  if (!user) return res.status(401).end();
  res.json({ token: sign(user) });
}

export async function logout(req, res) {
  console.log("logout", req.user);
  await audit.record("logout", req.user.id);
  res.status(204).end();
}
