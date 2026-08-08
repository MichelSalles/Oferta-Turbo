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
      // ignora JSON-LD inválido
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

  let text = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(/[R$]/gi, "");

  if (!text) return null;

  /*
   * Exemplos:
   * 35,91
   * 1.299,90
   * 35.91
   */
  if (
    text.includes(".") &&
    text.includes(",")
  ) {
    text = text
      .replace(/\./g, "")
      .replace(",", ".");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }

  text = text.replace(/[^\d.]/g, "");

  const parsed = Number(text);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function firstPriceMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      const value = normalizePrice(match[1]);

      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

function extractPriceData(html, jsonLd) {
  let price = null;
  let originalPrice = null;
  let discountPercent = null;

  const offers = jsonLd?.offers || {};

  /*
   * 1) JSON-LD / metas padrão
   */
  price =
    normalizePrice(offers?.price) ||
    normalizePrice(
      extractMeta(
        html,
        "product:price:amount"
      )
    );

  /*
   * 2) Padrões internos comuns do Mercado Livre
   */
  if (!price) {
    price = firstPriceMatch(html, [
      /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"amount"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"current_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"currentPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"sale_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"salePrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    ]);
  }

  /*
   * 3) Procura preço no HTML visível
   *
   * Ex:
   * R$ 35,91
   */
  if (!price) {
    price = firstPriceMatch(html, [
      /R\$\s*([0-9.]+,[0-9]{2})/i,
      /R\$\s*([0-9.]+)/i,
    ]);
  }

  /*
   * Preço anterior
   */
  originalPrice = firstPriceMatch(html, [
    /"original_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"originalPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"previous_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"previousPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"list_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"listPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
  ]);

  /*
   * Padrão visual de preço riscado.
   * Exemplo:
   * R$ 61
   */
  if (!originalPrice) {
    const allPrices = [
      ...html.matchAll(
        /R\$\s*([0-9.]+(?:,[0-9]{2})?)/gi
      ),
    ]
      .map((match) =>
        normalizePrice(match[1])
      )
      .filter(
        (value) =>
          value !== null &&
          value > 0
      );

    if (price && allPrices.length) {
      const possiblePrevious =
        allPrices.filter(
          (value) => value > price
        );

      if (possiblePrevious.length) {
        originalPrice = Math.min(
          ...possiblePrevious
        );
      }
    }
  }

  /*
   * Desconto explícito no HTML.
   * Ex: 41% OFF
   */
  const discountMatch =
    html.match(
      /(\d{1,2})\s*%\s*OFF/i
    );

  if (discountMatch?.[1]) {
    discountPercent =
      Number(discountMatch[1]);
  }

  /*
   * Se não achou explicitamente,
   * calcula pelo preço anterior.
   */
  if (
    !discountPercent &&
    originalPrice &&
    price &&
    originalPrice > price
  ) {
    discountPercent =
      Math.round(
        ((originalPrice - price) /
          originalPrice) *
          100
      );
  }

  /*
   * Sanitização
   */
  if (
    originalPrice &&
    price &&
    originalPrice <= price
  ) {
    originalPrice = null;
  }

  return {
    price,
    originalPrice,
    discountPercent,
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
     * Preços e desconto
     */
    const {
      price,
      originalPrice,
      discountPercent,
    } = extractPriceData(
      html,
      jsonLd
    );

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

    if (
      !title &&
      !price &&
      !image
    ) {
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

        affiliate_url:
          url,

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