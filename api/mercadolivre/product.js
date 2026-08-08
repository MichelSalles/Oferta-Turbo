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
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  let text = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(/[R$]/gi, "");

  if (!text) {
    return null;
  }

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
      const value =
        normalizePrice(match[1]);

      if (value !== null) {
        return value;
      }
    }
  }

  return null;
}

function extractSplitMercadoLivrePrices(html) {
  const results = [];

  /*
   * Tenta encontrar blocos onde o Mercado Livre
   * separa parte inteira e centavos.
   *
   * Exemplo visual:
   * 35 + 91 => 35.91
   */
  const splitPatterns = [
    /(?:andes-money-amount__fraction|price-tag-fraction)[^>]*>\s*([0-9.]+)\s*<[\s\S]{0,300}?(?:andes-money-amount__cents|price-tag-cents)[^>]*>\s*([0-9]{1,2})\s*</gi,

    /"fraction"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"cents"\s*:\s*"?([0-9]{1,2})"?/gi,

    /"integer"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"decimal"\s*:\s*"?([0-9]{1,2})"?/gi,
  ];

  for (const pattern of splitPatterns) {
    let match;

    while (
      (match = pattern.exec(html)) !== null
    ) {
      const integerPart =
        String(match[1]).replace(/\./g, "");

      const centsPart =
        String(match[2]).padEnd(2, "0");

      const value = Number(
        `${integerPart}.${centsPart}`
      );

      if (
        Number.isFinite(value) &&
        value > 0
      ) {
        results.push(value);
      }
    }
  }

  return [
    ...new Set(results),
  ];
}

function extractVisiblePrices(html) {
  const values = [];

  /*
   * R$ 35,91
   * R$ 61
   */
  const regex =
    /R\$\s*([0-9.]+(?:,[0-9]{1,2})?)/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    const value =
      normalizePrice(match[1]);

    if (
      value !== null &&
      value > 0
    ) {
      values.push(value);
    }
  }

  return [
    ...new Set(values),
  ];
}

function extractPriceData(
  html,
  jsonLd,
  discountPercentFromPage
) {
  let price = null;
  let originalPrice = null;

  const offers =
    jsonLd?.offers || {};

  /*
   * 1. JSON-LD / metas
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
   * 2. Campos internos
   */
  if (!price) {
    price = firstPriceMatch(html, [
      /"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"current_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"currentPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"sale_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"salePrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    ]);
  }

  originalPrice =
    firstPriceMatch(html, [
      /"original_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"originalPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"previous_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"previousPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"list_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
      /"listPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    ]);

  /*
   * 3. Preços separados em reais + centavos
   */
  const splitPrices =
    extractSplitMercadoLivrePrices(html);

  /*
   * 4. Preços visíveis no HTML
   */
  const visiblePrices =
    extractVisiblePrices(html);

  const candidates = [
    ...splitPrices,
    ...visiblePrices,
  ]
    .filter(
      (value) =>
        Number.isFinite(value) &&
        value > 0 &&
        value < 1000000
    );

  const uniqueCandidates = [
    ...new Set(candidates),
  ];

  /*
   * Se ainda não temos preço,
   * tenta inferir pelo desconto conhecido.
   *
   * Ex.: 35.91 e 61 com 41%.
   */
  if (
    !price &&
    uniqueCandidates.length
  ) {
    if (
      discountPercentFromPage
    ) {
      let bestPair = null;
      let bestDifference =
        Infinity;

      for (
        const current of uniqueCandidates
      ) {
        for (
          const previous of uniqueCandidates
        ) {
          if (previous <= current) {
            continue;
          }

          const calculated =
            Math.round(
              ((previous - current) /
                previous) *
                100
            );

          const difference =
            Math.abs(
              calculated -
                discountPercentFromPage
            );

          if (
            difference <
            bestDifference
          ) {
            bestDifference =
              difference;

            bestPair = {
              current,
              previous,
            };
          }
        }
      }

      if (
        bestPair &&
        bestDifference <= 2
      ) {
        price =
          bestPair.current;

        originalPrice =
          bestPair.previous;
      }
    }

    /*
     * Se não encontrou par pelo desconto,
     * pega o menor valor como preço atual.
     */
    if (!price) {
      price = Math.min(
        ...uniqueCandidates
      );
    }
  }

  /*
   * Descobre preço anterior
   * caso ainda esteja faltando.
   */
  if (
    price &&
    !originalPrice &&
    uniqueCandidates.length
  ) {
    const higherPrices =
      uniqueCandidates
        .filter(
          (value) =>
            value > price
        )
        .sort(
          (a, b) => a - b
        );

    if (higherPrices.length) {
      originalPrice =
        higherPrices[0];
    }
  }

  /*
   * Se temos desconto e preço atual,
   * podemos estimar o preço anterior
   * como último fallback.
   */
  if (
    price &&
    !originalPrice &&
    discountPercentFromPage &&
    discountPercentFromPage > 0 &&
    discountPercentFromPage < 100
  ) {
    const estimated =
      price /
      (
        1 -
        discountPercentFromPage /
          100
      );

    originalPrice =
      Math.round(
        estimated * 100
      ) / 100;
  }

  /*
   * Validação
   */
  if (
    originalPrice &&
    price &&
    originalPrice <= price
  ) {
    originalPrice = null;
  }

  let discountPercent =
    discountPercentFromPage ||
    null;

  if (
    !discountPercent &&
    price &&
    originalPrice
  ) {
    discountPercent =
      Math.round(
        ((originalPrice - price) /
          originalPrice) *
          100
      );
  }

  return {
    price,
    originalPrice,
    discountPercent,
    debugCandidates:
      uniqueCandidates,
  };
}

module.exports = async function handler(
  req,
  res
) {
  if (req.method !== "GET") {
    res.setHeader(
      "Allow",
      ["GET"]
    );

    return res.status(405).json({
      error:
        "Method not allowed",
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

    const html =
      resolved.html;

    const finalUrl =
      resolved.finalUrl;

    if (!html) {
      return res.status(502).json({
        error:
          "Não foi possível carregar a página do produto.",

        final_url:
          finalUrl,
      });
    }

    const jsonLd =
      extractJsonLd(html);

    /*
     * Título
     */
    const title =
      jsonLd?.name ||
      extractMeta(
        html,
        "og:title"
      ) ||
      extractMeta(
        html,
        "twitter:title"
      );

    /*
     * Imagem
     */
    let image =
      jsonLd?.image ||
      extractMeta(
        html,
        "og:image"
      ) ||
      extractMeta(
        html,
        "twitter:image"
      );

    if (
      Array.isArray(image)
    ) {
      image = image[0];
    }

    /*
     * Desconto explícito
     */
    const discountMatch =
      html.match(
        /(\d{1,2})\s*%\s*OFF/i
      );

    const explicitDiscount =
      discountMatch?.[1]
        ? Number(
            discountMatch[1]
          )
        : null;

    /*
     * Preços
     */
    const {
      price,
      originalPrice,
      discountPercent,
      debugCandidates,
    } = extractPriceData(
      html,
      jsonLd,
      explicitDiscount
    );

    /*
     * ID
     */
    const itemId =
      extractItemId(html) ||
      extractItemId(finalUrl);

    /*
     * Frete grátis
     */
    const freeShipping =
      /frete gr[aá]tis/i.test(
        html
      ) ||
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

        item_id:
          itemId,

        final_url:
          finalUrl,
      });
    }

    return res.status(200).json({
      success: true,

      product: {
        id:
          itemId,

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

      /*
       * Temporário para diagnóstico.
       * Depois retiramos.
       */
      debug: {
        price_candidates:
          debugCandidates,
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