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
      // Ignora JSON-LD inválido
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

function extractSplitPrices(html) {
  const results = [];

  const patterns = [
    /(?:andes-money-amount__fraction|price-tag-fraction)[^>]*>\s*([0-9.]+)\s*<[\s\S]{0,300}?(?:andes-money-amount__cents|price-tag-cents)[^>]*>\s*([0-9]{1,2})\s*</gi,

    /"fraction"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"cents"\s*:\s*"?([0-9]{1,2})"?/gi,

    /"integer"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"decimal"\s*:\s*"?([0-9]{1,2})"?/gi,
  ];

  for (const pattern of patterns) {
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

  return results;
}

function extractVisiblePrices(html) {
  const results = [];

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
      results.push(value);
    }
  }

  return results;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function calculatePreviousPrice(
  currentPrice,
  discountPercent
) {
  if (
    !currentPrice ||
    !discountPercent ||
    discountPercent <= 0 ||
    discountPercent >= 100
  ) {
    return null;
  }

  const estimated =
    currentPrice /
    (1 - discountPercent / 100);

  /*
   * Mercado Livre frequentemente mostra
   * o preço antigo sem centavos.
   *
   * Ex:
   * 35,91 com 41% OFF
   * estimado = 60,86
   * exibido = 61
   */
  const nearestInteger =
    Math.round(estimated);

  if (
    Math.abs(
      estimated - nearestInteger
    ) <= 0.20
  ) {
    return nearestInteger;
  }

  return roundMoney(estimated);
}

function extractPriceData(
  html,
  jsonLd,
  discountPercent
) {
  const offers =
    jsonLd?.offers || {};

  /*
   * Primeiro tenta os dados estruturados.
   */
  let price =
    normalizePrice(
      offers?.price
    ) ||
    normalizePrice(
      extractMeta(
        html,
        "product:price:amount"
      )
    );

  /*
   * Lista de preços na ordem em que
   * aparecem no HTML.
   *
   * Isso é importante porque o produto
   * principal aparece antes das recomendações.
   */
  const splitPrices =
    extractSplitPrices(html);

  const visiblePrices =
    extractVisiblePrices(html);

  const allCandidates = [];

  for (
    const value of [
      ...splitPrices,
      ...visiblePrices,
    ]
  ) {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value >= 1000000
    ) {
      continue;
    }

    if (
      !allCandidates.includes(value)
    ) {
      allCandidates.push(value);
    }
  }

  /*
   * Se JSON-LD não trouxe o preço,
   * usamos o PRIMEIRO preço capturado.
   *
   * No seu caso:
   * 35.91 é o primeiro valor.
   *
   * Isso evita pegar preços dos produtos
   * recomendados abaixo.
   */
  if (
    !price &&
    allCandidates.length > 0
  ) {
    price =
      allCandidates[0];
  }

  /*
   * Procura preço anterior explícito.
   */
  const originalPatterns = [
    /"original_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"originalPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"previous_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"previousPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"list_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"listPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];

  let originalPrice = null;

  for (
    const pattern of originalPatterns
  ) {
    const match =
      html.match(pattern);

    if (match?.[1]) {
      const candidate =
        normalizePrice(match[1]);

      if (
        candidate &&
        price &&
        candidate > price
      ) {
        originalPrice =
          candidate;

        break;
      }
    }
  }

  /*
   * Se não encontrou o preço anterior
   * explicitamente, calculamos usando
   * o desconto oficial da página.
   */
  if (
    !originalPrice &&
    price &&
    discountPercent
  ) {
    originalPrice =
      calculatePreviousPrice(
        price,
        discountPercent
      );
  }

  /*
   * Segurança.
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
    candidates:
      allCandidates,
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
      image =
        image[0];
    }

    /*
     * Desconto oficial exibido.
     *
     * Ex:
     * 41% OFF
     */
    const discountMatch =
      html.match(
        /(\d{1,2})\s*%\s*OFF/i
      );

    const discountPercent =
      discountMatch?.[1]
        ? Number(
            discountMatch[1]
          )
        : null;

    /*
     * Preço atual +
     * preço anterior.
     */
    const prices =
      extractPriceData(
        html,
        jsonLd,
        discountPercent
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
      /frete gr[aá]tis/i.test(
        html
      ) ||
      /"free_shipping"\s*:\s*true/i.test(
        html
      );

    return res.status(200).json({
      success: true,

      product: {
        id:
          itemId,

        title:
          title || null,

        price:
          prices.price,

        original_price:
          prices.originalPrice,

        discount_percent:
          prices.discountPercent,

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
       * Ainda vamos deixar esse debug
       * durante o teste.
       *
       * Depois removemos.
       */
      debug: {
        price_candidates:
          prices.candidates,
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