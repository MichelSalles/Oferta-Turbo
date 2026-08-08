module.exports = async function handler(req, res) {
  try {
    const id = req.query.id || "MLB4774039405";

    const cookies = req.headers.cookie || "";

    const accessTokenCookie = cookies
      .split(";")
      .map((item) => item.trim())
      .find((item) =>
        item.startsWith("meli_access_token=")
      );

    if (!accessTokenCookie) {
      return res.status(401).json({
        error: "Mercado Livre não conectado."
      });
    }

    const accessToken = decodeURIComponent(
      accessTokenCookie.substring(
        "meli_access_token=".length
      )
    );

    const response = await fetch(
      `https://api.mercadolibre.com/items?ids=${encodeURIComponent(id)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const data = await response.json();

    return res.status(response.status).json({
      status: response.status,
      data
    });

  } catch (error) {
    return res.status(500).json({
      error: "Erro no teste.",
      message: error.message
    });
  }
};