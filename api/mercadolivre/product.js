function extractItemId(text = "") {
  const patterns = [
    /\bMLB[-_]?(\d{6,})\b/i,
    /\/p\/MLB(\d{6,})/i,
    /\/MLB-(\d{6,})/i,
    /item_id=MLB(\d{6,})/i,
    /"item_id"\s*:\s*"?(MLB\d{6,})"?/i,
    /"id"\s*:\s*"?(MLB\d{6,})"?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      const value = match[1];

      if (/^MLB/i.test(value)) {
        return value.toUpperCase();
      }

      return `MLB${value}`;
    }
  }

  return null;
}

async function resolveMercadoLivreUrl(startUrl) {
  let currentUrl = startUrl;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",

    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  for (let i = 0; i < 8; i++) {
    console.log(`Redirect ${i}:`, currentUrl);

    // Primeiro tenta encontrar o MLB diretamente na URL
    const directId = extractItemId(currentUrl);

    if (directId) {
      return {
        finalUrl: currentUrl,
        itemId: directId,
      };
    }

    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers,
    });

    // Verifica redirecionamento HTTP
    const location = response.headers.get("location");

    if (location) {
      currentUrl = new URL(
        location,
        currentUrl
      ).toString();

      continue;
    }

    const contentType =
      response.headers.get("content-type") || "";

    // Se recebemos HTML, procuramos o MLB dentro da página
    if (contentType.includes("text/html")) {
      const html = await response.text();

      const idFromHtml = extractItemId(html);

      if (idFromHtml) {
        return {
          finalUrl: currentUrl,
          itemId: idFromHtml,
        };
      }

      // Procura URL canonical ou og:url
      const canonical =
        html.match(
          /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i
        ) ||
        html.match(
          /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)/i
        );

      if (canonical?.[1]) {
        const nextUrl = new URL(
          canonical[1],
          currentUrl
        ).toString();

        if (nextUrl !== currentUrl) {
          currentUrl = nextUrl;
          continue;
        }
      }

      // Alguns redirecionamentos usam meta refresh
      const httpEquiv = html.match(
        /url=([^"'<> ]+)/i
      );

      if (httpEquiv?.[1]) {
        currentUrl = new URL(
          httpEquiv[1],
          currentUrl
        ).toString();

        continue;
      }
    }

    break;
  }

  return {
    finalUrl: currentUrl,
    itemId: extractItemId(currentUrl),
  };
}

module.exports = async function handler(req, res) {
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

    let itemId = id
      ? extractItemId(id)
      : null;

    let finalUrl = url || "";

    // Tenta encontrar MLB diretamente no link
    if (!itemId && url) {
      itemId = extractItemId(url);
    }

    // Se for meli.la/social/etc., resolve o link
    if (!itemId && url) {
      const resolved =
        await resolveMercadoLivreUrl(url);

      finalUrl = resolved.finalUrl;
      itemId = resolved.itemId;
    }

    if (!itemId) {
      return res.status(400).json({
        error:
          "Não foi possível identificar o ID do produto.",

        original_url: url || null,
        final_url: finalUrl || null,
      });
    }

    console.log(
      "Produto identificado:",
      itemId
    );

    /*
     * IMPORTANTE:
     *
     * Não enviamos o access_token aqui.
     *
     * Estamos testando a consulta pública
     * do produto diretamente na API.
     */

    const response = await fetch(
      `https://api.mercadolibre.com/items/${itemId}`,
      {
        method: "GET",

        headers: {
          Accept: "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Erro API Mercado Livre:",
        data
      );

      return res
        .status(response.status)
        .json({
          error:
            "Erro ao consultar produto no Mercado Livre.",

          item_id: itemId,

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
            ((originalPrice - data.price) /
              originalPrice) *
              100
          )
        : null;

    const pictures = Array.isArray(
      data.pictures
    )
      ? data.pictures
          .map(
            (picture) =>
              picture.secure_url ||
              picture.url
          )
          .filter(Boolean)
      : [];

    return res.status(200).json({
      success: true,

      product: {
        id: data.id,

        title: data.title,

        price: data.price,

        original_price:
          originalPrice,

        discount_percent:
          discountPercent,

        currency:
          data.currency_id,

        permalink:
          data.permalink,

        original_url:
          url || null,

        final_url:
          finalUrl ||
          data.permalink,

        thumbnail:
          data.thumbnail,

        pictures,

        condition:
          data.condition,

        available_quantity:
          data.available_quantity,

        sold_quantity:
          data.sold_quantity,

        free_shipping:
          data.shipping?.free_shipping ===
          true,

        category_id:
          data.category_id,

        seller_id:
          data.seller_id,

        listing_type_id:
          data.listing_type_id,
      },
    });
  } catch (error) {
    console.error(
      "Erro product.js:",
      error
    );

    return res.status(500).json({
      error:
        "Erro interno ao consultar produto.",

      message:
        error?.message ||
        "Erro desconhecido.",
    });
  }
};