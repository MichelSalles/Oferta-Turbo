function extractItemId(text = "") {
  const patterns = [
    /\bMLB[-_]?(\d{6,})\b/i,
    /\/p\/MLB(\d{6,})/i,
    /\/MLB-(\d{6,})/i,
    /item_id=MLB(\d{6,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return `MLB${match[1]}`;
    }
  }

  return null;
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";

  const cookie = cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  if (!cookie) return null;

  return decodeURIComponent(cookie.substring(name.length + 1));
}

async function resolveShortUrl(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const location = response.headers.get("location");

    if (location) {
      return new URL(location, url).toString();
    }

    return response.url || url;
  } catch (error) {
    console.error("Erro ao resolver link curto:", error);
    return url;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);

    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { url, id } = req.query;

    if (!url && !id) {
      return res.status(400).json({
        error: "Informe o link ou ID do produto.",
      });
    }

    let itemId = id ? extractItemId(id) : null;
    let finalUrl = url || "";

    if (!itemId && url) {
      itemId = extractItemId(url);
    }

    if (!itemId && url?.includes("meli.la")) {
      finalUrl = await resolveShortUrl(url);
      itemId = extractItemId(finalUrl);
    }

    if (!itemId) {
      return res.status(400).json({
        error: "Não foi possível identificar o ID do produto.",
        final_url: finalUrl || null,
      });
    }

    const accessToken = getCookie(req, "meli_access_token");

    const headers = {
      Accept: "application/json",
    };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const response = await fetch(
      `https://api.mercadolibre.com/items/${itemId}`,
      {
        headers,
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Erro ao consultar produto no Mercado Livre.",
        details: data,
      });
    }

    const originalPrice =
      data.original_price &&
      data.original_price > data.price
        ? data.original_price
        : null;

    const discountPercent =
      originalPrice && data.price
        ? Math.round(
            ((originalPrice - data.price) / originalPrice) * 100
          )
        : null;

    return res.status(200).json({
      success: true,

      product: {
        id: data.id,
        title: data.title,

        price: data.price,
        original_price: originalPrice,
        discount_percent: discountPercent,

        currency: data.currency_id,

        permalink: data.permalink,
        final_url: finalUrl || data.permalink,

        thumbnail: data.thumbnail,
        pictures:
          data.pictures?.map((picture) => picture.secure_url) || [],

        condition: data.condition,

        available_quantity: data.available_quantity,
        sold_quantity: data.sold_quantity,

        free_shipping:
          data.shipping?.free_shipping === true,

        category_id: data.category_id,
        seller_id: data.seller_id,
      },
    });
  } catch (error) {
    console.error("Erro product.js:", error);

    return res.status(500).json({
      error