import crypto from "crypto";

const REDIRECT_URI =
  "https://oferta-turbo.vercel.app/api/mercadolivre/callback";

function base64url(input) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const clientId = process.env.MELI_CLIENT_ID;

  if (!clientId) {
    return res.status(500).json({
      error: "MELI_CLIENT_ID não configurado.",
    });
  }

  const codeVerifier = base64url(crypto.randomBytes(64));

  const codeChallenge = base64url(
    crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest()
  );

  res.setHeader(
    "Set-Cookie",
    `meli_code_verifier=${encodeURIComponent(
      codeVerifier
    )}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const authUrl = new URL(
    "https://auth.mercadolivre.com.br/authorization"
  );

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return res.redirect(302, authUrl.toString());
}