function extractItemId(text = "") {
  const match = text.match(/\bMLB[-_]?(\d{6,})\b/i);

  if (!match) return null;

  return `MLB${match[1]}`;
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

async function resolveUrl(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
    });

    return response.url || url;
  } catch {
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
      finalUrl = await resolveUrl(url);
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

        listing_type_id: data.listing_type_id,
        category_id: data.category_id,

        seller_id: data.seller_id,
      },
    });
  } catch (error) {
    console.error("Erro product.js:", error);

    return res.status(500).json({
      error: "Erro interno ao consultar produto.",
    });
  }
}