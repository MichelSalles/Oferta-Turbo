const REDIRECT_URI =
  "https://oferta-turbo.vercel.app/api/mercadolivre/callback";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).json({
      connected: false,
      error,
      description: error_description || null,
    });
  }

  if (!code) {
    return res.status(400).json({
      connected: false,
      error: "Código de autorização não recebido.",
    });
  }

  try {
    const response = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: process.env.MELI_CLIENT_ID,
          client_secret: process.env.MELI_CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        connected: false,
        error: data?.error || "oauth_error",
        message:
          data?.message ||
          "Não foi possível concluir a autenticação.",
      });
    }

    console.log("Mercado Livre conectado.", {
      user_id: data.user_id,
      expires_in: data.expires_in,
    });

    return res.status(200).json({
      connected: true,
      user_id: data.user_id,
      expires_in: data.expires_in,
      message: "Mercado Livre conectado ao Oferta Turbo.",
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      connected: false,
      error: "internal_error",
    });
  }
}