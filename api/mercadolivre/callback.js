const REDIRECT_URI =
  "https://oferta-turbo.vercel.app/api/mercadolivre/callback";

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";

  const cookie = cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  if (!cookie) return null;

  return decodeURIComponent(cookie.substring(name.length + 1));
}

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

  const codeVerifier = getCookie(req, "meli_code_verifier");

  if (!codeVerifier) {
    return res.status(400).json({
      connected: false,
      error:
        "PKCE code_verifier não encontrado. Inicie a conexão novamente pelo Oferta Turbo.",
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
          code_verifier: codeVerifier,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro OAuth Mercado Livre:", {
        status: response.status,
        error: data?.error,
        message: data?.message,
      });

      return res.status(response.status).json({
        connected: false,
        error: data?.error || "oauth_error",
        message:
          data?.message ||
          "Não foi possível concluir a autenticação do Mercado Livre.",
      });
    }

    /*
      Por enquanto salvamos os tokens em cookies HttpOnly.
      Depois vamos migrar isso para armazenamento persistente seguro.
    */

    const secureCookie = [
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
    ];

    res.setHeader("Set-Cookie", [
      `meli_access_token=${encodeURIComponent(
        data.access_token
      )}; Max-Age=${data.expires_in || 21600}; ${secureCookie.join("; ")}`,

      `meli_refresh_token=${encodeURIComponent(
        data.refresh_token
      )}; Max-Age=15552000; ${secureCookie.join("; ")}`,

      `meli_code_verifier=; Max-Age=0; ${secureCookie.join("; ")}`,
    ]);

    console.log("Mercado Livre conectado com sucesso.", {
      user_id: data.user_id,
      expires_in: data.expires_in,
    });

    return res.redirect(
      302,
      "/?mercadolivre=connected"
    );
  } catch (err) {
    console.error("Erro interno OAuth Mercado Livre:", err);

    return res.status(500).json({
      connected: false,
      error: "internal_error",
      message:
        "Erro interno ao conectar o Mercado Livre.",
    });
  }
}