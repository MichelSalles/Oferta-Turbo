const REDIRECT_URI =
  "https://oferta-turbo.vercel.app/api/mercadolivre/callback";

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

  const authUrl = new URL(
    "https://auth.mercadolivre.com.br/authorization"
  );

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);

  return res.redirect(302, authUrl.toString());
}