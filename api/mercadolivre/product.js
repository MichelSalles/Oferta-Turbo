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
      lastHtml =
        await response.text();
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
  } else if (
    text.includes(",")
  ) {
    text =
      text.replace(",", ".");
  }

  text =
    text.replace(/[^\d.]/g, "");

  const parsed =
    Number(text);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function roundMoney(value) {
  return Math.round(
    value * 100
  ) / 100;
}

/*
 * Extrai preços visíveis no formato:
 *
 * R$ 78,90
 * R$ 55,90
 */
function extractVisiblePriceOccurrences(html) {
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
      value > 0 &&
      value < 1000000
    ) {
      results.push({
        value,
        index: match.index,
        source: "visible",
      });
    }
  }

  return results;
}

/*
 * Mercado Livre costuma montar preços assim:
 *
 * fraction = 55
 * cents = 90
 *
 * Essa função preserva também a posição
 * do preço dentro do HTML.
 */
function extractSplitPriceOccurrences(html) {
  const results = [];

  const patterns = [
    /(?:andes-money-amount__fraction|price-tag-fraction)[^>]*>\s*([0-9.]+)\s*<[\s\S]{0,350}?(?:andes-money-amount__cents|price-tag-cents)[^>]*>\s*([0-9]{1,2})\s*</gi,

    /"fraction"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"cents"\s*:\s*"?([0-9]{1,2})"?/gi,

    /"integer"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"decimal"\s*:\s*"?([0-9]{1,2})"?/gi,
  ];

  for (const pattern of patterns) {
    let match;

    while (
      (match = pattern.exec(html)) !== null
    ) {
      const integerPart =
        String(match[1])
          .replace(/\./g, "");

      const centsPart =
        String(match[2])
          .padStart(2, "0");

      const value =
        Number(
          `${integerPart}.${centsPart}`
        );

      if (
        Number.isFinite(value) &&
        value > 0 &&
        value < 1000000
      ) {
        results.push({
          value,
          index: match.index,
          source: "split",
        });
      }
    }
  }

  return results;
}

/*
 * Junta preços duplicados que aparecem
 * praticamente na mesma região do HTML.
 */
function cleanOccurrences(items) {
  const sorted = [...items].sort(
    (a, b) =>
      a.index - b.index
  );

  const result = [];

  for (const item of sorted) {
    const duplicate =
      result.some(
        (existing) =>
          existing.value ===
            item.value &&
          Math.abs(
            existing.index -
            item.index
          ) < 350
      );

    if (!duplicate) {
      result.push(item);
    }
  }

  return result;
}

/*
 * NOVA ESTRATÉGIA:
 *
 * Encontramos o "% OFF".
 *
 * Depois procuramos os valores monetários
 * imediatamente ANTES desse desconto.
 *
 * Mercado Livre normalmente renderiza:
 *
 * preço antigo
 * preço atual
 * desconto
 *
 * Ex:
 *
 * 78,90
 * 55,90
 * 29% OFF
 *
 * Portanto:
 *
 * último preço antes do desconto = atual
 * penúltimo preço antes do desconto = antigo
 */
function extractPricesNearDiscount(
  html,
  discountMatch
) {
  if (!discountMatch) {
    return null;
  }

  const discountIndex =
    discountMatch.index;

  const occurrences =
    cleanOccurrences([
      ...extractVisiblePriceOccurrences(
        html
      ),

      ...extractSplitPriceOccurrences(
        html
      ),
    ]);

  /*
   * Limitamos a busca a uma região
   * relativamente próxima do desconto.
   *
   * Isso evita preços de recomendações.
   */
  let previous =
    occurrences.filter(
      (item) =>
        item.index <
          discountIndex &&
        discountIndex -
          item.index <
          6000
    );

  /*
   * Mantemos só valores distintos,
   * preservando a ordem da página.
   */
  const unique = [];

  for (const item of previous) {
    const last =
      unique[
        unique.length - 1
      ];

    if (
      !last ||
      last.value !==
        item.value
    ) {
      unique.push(item);
    }
  }

  /*
   * Estamos interessados nos valores
   * MAIS PRÓXIMOS do desconto.
   */
  if (unique.length >= 2) {
    const current =
      unique[
        unique.length - 1
      ].value;

    const old =
      unique[
        unique.length - 2
      ].value;

    /*
     * O preço antigo precisa ser maior.
     */
    if (old > current) {
      return {
        price: current,
        originalPrice: old,
        nearbyCandidates:
          unique
            .slice(-6)
            .map(
              (item) =>
                item.value
            ),
      };
    }
  }

  /*
   * Às vezes só conseguimos encontrar
   * o preço atual próximo ao desconto.
   */
  if (unique.length >= 1) {
    return {
      price:
        unique[
          unique.length - 1
        ].value,

      originalPrice:
        null,

      nearbyCandidates:
        unique
          .slice(-6)
          .map(
            (item) =>
              item.value
          ),
    };
  }

  return null;
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
    (
      1 -
      discountPercent / 100
    );

  const nearestInteger =
    Math.round(estimated);

  /*
   * Exemplo:
   *
   * 35,91 / 41% OFF
   * ≈ 60,86
   *
   * Mercado Livre exibe R$ 61.
   */
  if (
    Math.abs(
      estimated -
      nearestInteger
    ) <= 0.20
  ) {
    return nearestInteger;
  }

  return roundMoney(
    estimated
  );
}

function extractPriceData(
  html,
  jsonLd,
  discountMatch
) {
  const discountPercent =
    discountMatch?.[1]
      ? Number(
          discountMatch[1]
        )
      : null;

  /*
   * PRIORIDADE 1:
   * preços que estão junto do desconto.
   */
  const nearDiscount =
    extractPricesNearDiscount(
      html,
      discountMatch
    );

  if (
    nearDiscount?.price
  ) {
    let originalPrice =
      nearDiscount.originalPrice;

    /*
     * Se só achamos o preço atual,
     * usamos o desconto como fallback.
     */
    if (
      !originalPrice &&
      discountPercent
    ) {
      originalPrice =
        calculatePreviousPrice(
          nearDiscount.price,
          discountPercent
        );
    }

    return {
      price:
        nearDiscount.price,

      originalPrice,

      discountPercent,

      nearbyCandidates:
        nearDiscount
          .nearbyCandidates,

      strategy:
        "near_discount",
    };
  }

  /*
   * PRIORIDADE 2:
   * dados estruturados.
   */
  const offers =
    jsonLd?.offers || {};

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
   * PRIORIDADE 3:
   * primeiro preço disponível.
   */
  const allOccurrences =
    cleanOccurrences([
      ...extractVisiblePriceOccurrences(
        html
      ),

      ...extractSplitPriceOccurrences(
        html
      ),
    ]);

  const allCandidates =
    allOccurrences.map(
      (item) =>
        item.value
    );

  if (
    !price &&
    allCandidates.length
  ) {
    price =
      allCandidates[0];
  }

  let originalPrice =
    null;

  const originalPatterns = [
    /"original_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"originalPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"previous_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"previousPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"list_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"listPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];

  for (
    const pattern of
      originalPatterns
  ) {
    const match =
      html.match(pattern);

    if (match?.[1]) {
      const candidate =
        normalizePrice(
          match[1]
        );

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

  if (
    originalPrice &&
    price &&
    originalPrice <= price
  ) {
    originalPrice =
      null;
  }

  return {
    price,
    originalPrice,
    discountPercent,

    nearbyCandidates:
      allCandidates.slice(
        0,
        10
      ),

    strategy:
      "fallback",
  };
}

module.exports =
async function handler(
  req,
  res
) {
  if (
    req.method !== "GET"
  ) {
    res.setHeader(
      "Allow",
      ["GET"]
    );

    return res
      .status(405)
      .json({
        error:
          "Method not allowed",
      });
  }

  try {
    const { url } =
      req.query;

    if (!url) {
      return res
        .status(400)
        .json({
          error:
            "Informe o link do Mercado Livre.",
        });
    }

    const resolved =
      await resolveProduct(
        url
      );

    const html =
      resolved.html;

    const finalUrl =
      resolved.finalUrl;

    if (!html) {
      return res
        .status(502)
        .json({
          error:
            "Não foi possível carregar a página do produto.",

          final_url:
            finalUrl,
        });
    }

    const jsonLd =
      extractJsonLd(
        html
      );

    /*
     * TÍTULO
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
     * IMAGEM
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
     * DESCONTO
     *
     * Pegamos também o INDEX,
     * porque agora ele é nossa
     * âncora para os preços.
     */
    const discountRegex =
      /(\d{1,2})\s*%\s*OFF/i;

    const discountMatch =
      discountRegex.exec(
        html
      );

    /*
     * PREÇOS
     */
    const prices =
      extractPriceData(
        html,
        jsonLd,
        discountMatch
      );

    /*
     * ID MLB
     */
    const itemId =
      extractItemId(
        html
      ) ||
      extractItemId(
        finalUrl
      );

    /*
     * FRETE
     */
    const freeShipping =
      /frete gr[aá]tis/i.test(
        html
      ) ||
      /"free_shipping"\s*:\s*true/i.test(
        html
      );

    return res
      .status(200)
      .json({
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
         * Vamos manter esse debug
         * por mais um teste.
         *
         * Depois retiramos.
         */
        debug: {
          price_strategy:
            prices.strategy,

          nearby_prices:
            prices
              .nearbyCandidates,
        },
      });

  } catch (error) {
    console.error(
      "Erro product.js:",
      error
    );

    return res
      .status(500)
      .json({
        error:
          "Erro interno ao buscar produto.",

        message:
          error?.message ||
          "Erro desconhecido.",
      });
  }
};