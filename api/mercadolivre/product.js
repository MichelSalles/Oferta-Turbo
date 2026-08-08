function decodeHtml(text = "") {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

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

function extractMeta(html, property) {
  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return decodeHtml(match[1]);
    }
  }

  return null;
}

function extractJsonLd(html) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];

  for (const match of scripts) {
    try {
      const parsed = JSON.parse(
        decodeHtml(match[1].trim())
      );

      const items = Array.isArray(parsed)
        ? parsed
        : [parsed];

      for (const item of items) {
        if (
          item &&
          (
            item["@type"] === "Product" ||
            item.name ||
            item.offers
          )
        ) {
          return item;
        }

        if (item?.["@graph"]) {
          const product = item["@graph"].find(
            (entry) =>
              entry?.["@type"] === "Product"
          );

          if (product) {
            return product;
          }
        }
      }
    } catch {
      // Ignora JSON-LD inválido.
    }
  }

  return null;
}

async function fetchPage(url) {
  return fetch(url, {
    method: "GET",
    redirect: "manual",

    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",

      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

      "Accept-Language":
        "pt-BR,pt;q=0.9,en;q=0.8",
    },
  });
}

async function resolveProduct(startUrl) {
  let currentUrl = startUrl;
  let lastHtml = "";

  for (let i = 0; i < 10; i++) {
    console.log(
      `Resolvendo link ${i}:`,
      currentUrl
    );

    const response =
      await fetchPage(currentUrl);

    const location =
      response.headers.get("location");

    if (location) {
      currentUrl = new URL(
        location,
        currentUrl
      ).toString();

      continue;
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      lastHtml = await response.text();

      const canonical =
        extractMeta(lastHtml, "og:url") ||
        lastHtml.match(
          /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i
        )?.[1];

      /*
       * Só segue canonical se realmente
       * levar para outra página.
       */
      if (
        canonical &&
        canonical !== currentUrl
      ) {
        const nextUrl = new URL(
          canonical,
          currentUrl
        ).toString();

        /*
         * Evita ficar preso em loop.
         */
        if (
          nextUrl !== currentUrl &&
          !currentUrl.includes(nextUrl)
        ) {
          currentUrl = nextUrl;
          continue;
        }
      }
    }

    break;
  }

  return {
    finalUrl: currentUrl,
    html: lastHtml,
  };
}

function normalizePrice(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  const clean = String(value)
    .replace(/[^\d.,]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const parsed = Number(clean);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);

    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        error:
          "Informe o link do Mercado Livre.",
      });
    }

    const resolved =
      await resolveProduct(url);

    const html = resolved.html;
    const finalUrl = resolved.finalUrl;

    if (!html) {
      return res.status(502).json({
        error:
          "Não foi possível carregar a página do produto.",
        final_url: finalUrl,
      });
    }

    const jsonLd =
      extractJsonLd(html);

    const offers =
      jsonLd?.offers || {};

    /*
     * Nome
     */
    const title =
      jsonLd?.name ||
      extractMeta(html, "og:title") ||
      extractMeta(html, "twitter:title");

    /*
     * Imagem
     */
    let image =
      jsonLd?.image ||
      extractMeta(html, "og:image") ||
      extractMeta(html, "twitter:image");

    if (Array.isArray(image)) {
      image = image[0];
    }

    /*
     * Preço atual
     */
    let price =
      normalizePrice(
        offers?.price ??
        extractMeta(
          html,
          "product:price:amount"
        )
      );

    /*
     * Outros padrões encontrados
     * em páginas de e-commerce.
     */
    if (!price) {
      const priceMatch =
        html.match(
          /"price"\s*:\s*"?([\d.]+)"?/i
        ) ||
        html.match(
          /"amount"\s*:\s*([\d.]+)/i
        );

      if (priceMatch?.[1]) {
        price =
          normalizePrice(priceMatch[1]);
      }
    }

    /*
     * Preço anterior.
     */
    let originalPrice = null;

    const originalPatterns = [
      /"original_price"\s*:\s*([\d.]+)/i,
      /"originalPrice"\s*:\s*([\d.]+)/i,
      /"previous_price"\s*:\s*([\d.]+)/i,
      /"previousPrice"\s*:\s*([\d.]+)/i,
    ];

    for (
      const pattern of originalPatterns
    ) {
      const match = html.match(pattern);

      if (match?.[1]) {
        originalPrice =
          normalizePrice(match[1]);

        break;
      }
    }

    if (
      originalPrice &&
      price &&
      originalPrice <= price
    ) {
      originalPrice = null;
    }

    const discountPercent =
      originalPrice && price
        ? Math.round(
            ((originalPrice - price) /
              originalPrice) *
              100
          )
        : null;

    /*
     * ID MLB
     */
    const itemId =
      extractItemId(html) ||
      extractItemId(finalUrl);

    /*
     * Frete grátis
     */
    const freeShipping =
      /frete gr[aá]tis/i.test(html) ||
      /"free_shipping"\s*:\s*true/i.test(
        html
      );

    if (!title && !price && !image) {
      return res.status(422).json({
        error:
          "A página foi encontrada, mas não foi possível extrair os dados do produto.",

        item_id: itemId,
        final_url: finalUrl,
      });
    }

    return res.status(200).json({
      success: true,

      product: {
        id: itemId,

        title:
          title || null,

        price,

        original_price:
          originalPrice,

        discount_percent:
          discountPercent,

        image:
          image || null,

        thumbnail:
          image || null,

        free_shipping:
          freeShipping,

        affiliate_url: url,

        final_url:
          finalUrl,
      },
    });
  } catch (error) {
    console.error(
      "Erro product.js:",
      error
    );

    return res.status(500).json({
      error:
        "Erro interno ao buscar produto.",

      message:
        error?.message ||
        "Erro desconhecido.",
    });
  }
};