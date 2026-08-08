function decodeHtml(text = "") {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(text = "") {
  return decodeHtml(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    const match = String(text).match(pattern);

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

  const products = [];

  function collect(value) {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (
      value["@type"] === "Product" ||
      value.offers ||
      value.name
    ) {
      products.push(value);
    }

    if (Array.isArray(value["@graph"])) {
      collect(value["@graph"]);
    }
  }

  for (const match of scripts) {
    try {
      const parsed = JSON.parse(
        decodeHtml(match[1].trim())
      );

      collect(parsed);
    } catch {
      // Ignora JSON-LD inválido.
    }
  }

  return products[0] || null;
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
    const response = await fetchPage(currentUrl);

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

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml")
    ) {
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
    value === null ||
    value === ""
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : null;
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

  text =
    text.replace(/[^\d.]/g, "");

  const parsed = Number(text);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function uniqueNumbers(values) {
  const result = [];

  for (const value of values) {
    const number =
      normalizePrice(value);

    if (
      number !== null &&
      number > 0 &&
      number < 1000000 &&
      !result.includes(number)
    ) {
      result.push(number);
    }
  }

  return result;
}

function getContext(html, index, radius = 450) {
  const start = Math.max(
    0,
    index - radius
  );

  const end = Math.min(
    html.length,
    index + radius
  );

  return stripHtml(
    html.slice(start, end)
  ).slice(0, 900);
}

function extractPriceEvidence(html) {
  const evidence = [];

  /*
   * Preços visíveis:
   * R$ 113
   * R$ 55,90
   */
  const visibleRegex =
    /R\$\s*([0-9.]+(?:,[0-9]{1,2})?)/gi;

  let match;

  while (
    (match =
      visibleRegex.exec(html)) !== null
  ) {
    const value =
      normalizePrice(match[1]);

    if (
      value !== null &&
      value > 0 &&
      value < 1000000
    ) {
      evidence.push({
        value,
        index: match.index,
        source: "visible_r$",
        context:
          getContext(
            html,
            match.index
          ),
      });
    }

    if (evidence.length >= 40) {
      break;
    }
  }

  /*
   * Preços montados em fraction + cents.
   */
  const splitPatterns = [
    /(?:andes-money-amount__fraction|price-tag-fraction)[^>]*>\s*([0-9.]+)\s*<[\s\S]{0,350}?(?:andes-money-amount__cents|price-tag-cents)[^>]*>\s*([0-9]{1,2})\s*</gi,

    /"fraction"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"cents"\s*:\s*"?([0-9]{1,2})"?/gi,

    /"integer"\s*:\s*"?([0-9.]+)"?[\s\S]{0,200}?"decimal"\s*:\s*"?([0-9]{1,2})"?/gi,
  ];

  for (const pattern of splitPatterns) {
    let splitMatch;

    while (
      (splitMatch =
        pattern.exec(html)) !== null
    ) {
      const integerPart =
        String(splitMatch[1])
          .replace(/\./g, "");

      const centsPart =
        String(splitMatch[2])
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
        evidence.push({
          value,
          index:
            splitMatch.index,
          source:
            "fraction_cents",
          context:
            getContext(
              html,
              splitMatch.index
            ),
        });
      }

      if (evidence.length >= 70) {
        break;
      }
    }
  }

  return evidence
    .sort(
      (a, b) =>
        a.index - b.index
    )
    .slice(0, 50);
}

function extractDiscountEvidence(html) {
  const results = [];

  const regex =
    /(\d{1,2})\s*%\s*OFF/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    const value =
      Number(match[1]);

    if (
      Number.isFinite(value) &&
      value > 0 &&
      value < 100
    ) {
      results.push({
        value,
        index:
          match.index,
        context:
          getContext(
            html,
            match.index
          ),
      });
    }

    if (results.length >= 30) {
      break;
    }
  }

  return results;
}

function calculateDiscount(
  oldPrice,
  currentPrice
) {
  if (
    !oldPrice ||
    !currentPrice ||
    oldPrice <= currentPrice
  ) {
    return null;
  }

  return Math.round(
    (
      (oldPrice - currentPrice) /
      oldPrice
    ) * 100
  );
}

function fallbackSelection(
  priceEvidence,
  discountEvidence,
  jsonLdPrice
) {
  const prices =
    uniqueNumbers([
      ...priceEvidence.map(
        (item) => item.value
      ),
      jsonLdPrice,
    ]).slice(0, 20);

  const discounts = [
    ...new Set(
      discountEvidence
        .map(
          (item) => item.value
        )
        .filter(Boolean)
    ),
  ].slice(0, 15);

  let bestPair = null;
  let bestScore = Infinity;

  for (
    let i = 0;
    i < prices.length;
    i++
  ) {
    const current =
      prices[i];

    for (
      let j = 0;
      j < prices.length;
      j++
    ) {
      const old =
        prices[j];

      if (old <= current) {
        continue;
      }

      const calculated =
        calculateDiscount(
          old,
          current
        );

      for (
        let d = 0;
        d < discounts.length;
        d++
      ) {
        const difference =
          Math.abs(
            calculated -
            discounts[d]
          );

        const score =
          difference +
          (i + j + d) * 0.05;

        if (
          difference <= 1 &&
          score < bestScore
        ) {
          bestScore = score;

          bestPair = {
            price: current,
            original_price: old,
            discount_percent:
              discounts[d],
            confidence: 0,
          };
        }
      }
    }
  }

  if (bestPair) {
    return bestPair;
  }

  return {
    price:
      jsonLdPrice ||
      prices[0] ||
      null,

    original_price:
      null,

    discount_percent:
      discounts[0] ||
      null,

    confidence: 0,
  };
}

function extractOutputText(data) {
  if (
    typeof data?.output_text ===
    "string" &&
    data.output_text.trim()
  ) {
    return data.output_text;
  }

  if (
    !Array.isArray(
      data?.output
    )
  ) {
    return null;
  }

  for (
    const item of data.output
  ) {
    if (
      !Array.isArray(
        item?.content
      )
    ) {
      continue;
    }

    for (
      const content of
        item.content
    ) {
      if (
        content?.type ===
          "output_text" &&
        typeof content.text ===
          "string"
      ) {
        return content.text;
      }
    }
  }

  return null;
}

function isAllowedPrice(
  value,
  priceCandidates
) {
  if (value === null) {
    return true;
  }

  return priceCandidates.some(
    (candidate) =>
      Math.abs(
        candidate - value
      ) < 0.011
  );
}

function validateAIResult(
  result,
  priceCandidates,
  discountCandidates
) {
  if (
    !result ||
    typeof result !== "object"
  ) {
    throw new Error(
      "Resposta da IA inválida."
    );
  }

  const price =
    normalizePrice(
      result.price
    );

  const originalPrice =
    normalizePrice(
      result.original_price
    );

  const discount =
    result.discount_percent ===
      null
      ? null
      : Number(
          result.discount_percent
        );

  let confidence =
    Number(
      result.confidence
    );

  if (
    !Number.isFinite(
      confidence
    )
  ) {
    confidence = 0;
  }

  confidence =
    Math.max(
      0,
      Math.min(
        1,
        confidence
      )
    );

  /*
   * A IA não pode inventar preço.
   */
  if (
    price !== null &&
    !isAllowedPrice(
      price,
      priceCandidates
    )
  ) {
    throw new Error(
      "IA escolheu um preço que não estava nos candidatos."
    );
  }

  if (
    originalPrice !== null &&
    !isAllowedPrice(
      originalPrice,
      priceCandidates
    )
  ) {
    throw new Error(
      "IA escolheu um preço anterior que não estava nos candidatos."
    );
  }

  if (
    originalPrice !== null &&
    price !== null &&
    originalPrice <= price
  ) {
    throw new Error(
      "Preço anterior inválido."
    );
  }

  if (
    discount !== null &&
    (
      !Number.isFinite(
        discount
      ) ||
      discount <= 0 ||
      discount >= 100
    )
  ) {
    throw new Error(
      "Desconto inválido."
    );
  }

  /*
   * Se a IA informou desconto,
   * verificamos se ele apareceu
   * na página ou se bate com o par.
   */
  if (
    discount !== null
  ) {
    const appeared =
      discountCandidates.some(
        (candidate) =>
          Math.abs(
            candidate -
            discount
          ) <= 1
      );

    const calculated =
      originalPrice &&
      price
        ? calculateDiscount(
            originalPrice,
            price
          )
        : null;

    const matchesPrices =
      calculated !== null &&
      Math.abs(
        calculated -
        discount
      ) <= 1;

    if (
      !appeared &&
      !matchesPrices
    ) {
      throw new Error(
        "Desconto escolhido pela IA não foi confirmado."
      );
    }
  }

  return {
    price,
    original_price:
      originalPrice,
    discount_percent:
      discount,
    confidence,
  };
}

async function analyzeWithAI({
  title,
  itemId,
  finalUrl,
  jsonLdPrice,
  priceEvidence,
  discountEvidence,
  freeShipping,
}) {
  if (
    !process.env
      .OPENAI_API_KEY
  ) {
    throw new Error(
      "OPENAI_API_KEY não configurada."
    );
  }

  const priceCandidates =
    uniqueNumbers([
      ...priceEvidence.map(
        (item) =>
          item.value
      ),
      jsonLdPrice,
    ]);

  const discountCandidates = [
    ...new Set(
      discountEvidence.map(
        (item) =>
          item.value
      )
    ),
  ];

  /*
   * Reduzimos os dados enviados
   * para manter custo e latência baixos.
   */
  const compactPriceEvidence =
    priceEvidence
      .slice(0, 35)
      .map(
        (
          item,
          index
        ) => ({
          candidate_id:
            `P${index + 1}`,
          value:
            item.value,
          source:
            item.source,
          position:
            item.index,
          context:
            item.context,
        })
      );

  const compactDiscountEvidence =
    discountEvidence
      .slice(0, 20)
      .map(
        (
          item,
          index
        ) => ({
          candidate_id:
            `D${index + 1}`,
          value:
            item.value,
          position:
            item.index,
          context:
            item.context,
        })
      );

  const userData = {
    marketplace:
      "Mercado Livre Brasil",

    product: {
      id:
        itemId || null,
      title:
        title || null,
      final_url:
        finalUrl || null,
      json_ld_price:
        jsonLdPrice,
      free_shipping_detected:
        freeShipping,
    },

    price_candidates:
      compactPriceEvidence,

    discount_candidates:
      compactDiscountEvidence,
  };

  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            model:
              "gpt-5-mini",

            store:
              false,

            max_output_tokens:
              300,

            input: [
              {
                role:
                  "system",

                content:
                  `Você é um extrator de dados de ofertas do Mercado Livre Brasil.

Sua única tarefa é identificar os valores do PRODUTO PRINCIPAL mostrado na página:
- price: preço atual principal à vista exibido para a variação selecionada;
- original_price: preço anterior riscado do mesmo produto/variação;
- discount_percent: percentual OFF correspondente ao mesmo par;
- confidence: confiança entre 0 e 1.

Regras obrigatórias:
1. Ignore valores de parcelas.
2. Ignore valores de cartão Mercado Pago.
3. Ignore linha de crédito.
4. Ignore descontos condicionais a cartão, cupom, Pix ou quantidade, a menos que sejam claramente o preço principal do anúncio.
5. Ignore preços de produtos recomendados, carrosséis, anúncios relacionados e outras ofertas.
6. Ignore outras variações não selecionadas.
7. Use título, posição e contexto de cada candidato para identificar o bloco principal.
8. O preço atual e o preço anterior devem existir nos candidatos recebidos. Nunca invente preço.
9. O desconto deve existir nos candidatos ou ser matematicamente compatível com os dois preços.
10. Se não houver evidência suficiente para um campo, devolva null.
11. Prefira dados que estejam no mesmo contexto do título/produto principal e próximos uns dos outros.
12. Preço anterior deve ser maior que preço atual.`,
              },

              {
                role:
                  "user",

                content:
                  JSON.stringify(
                    userData
                  ),
              },
            ],

            text: {
              format: {
                type:
                  "json_schema",

                name:
                  "mercado_livre_offer",

                strict:
                  true,

                schema: {
                  type:
                    "object",

                  additionalProperties:
                    false,

                  properties: {
                    price: {
                      type: [
                        "number",
                        "null",
                      ],
                    },

                    original_price: {
                      type: [
                        "number",
                        "null",
                      ],
                    },

                    discount_percent: {
                      type: [
                        "number",
                        "null",
                      ],
                    },

                    confidence: {
                      type:
                        "number",
                      minimum:
                        0,
                      maximum:
                        1,
                    },
                  },

                  required: [
                    "price",
                    "original_price",
                    "discount_percent",
                    "confidence",
                  ],
                },
              },
            },
          }),
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "Erro OpenAI:",
      JSON.stringify(
        data
      )
    );

    throw new Error(
      data?.error?.message ||
      `OpenAI HTTP ${response.status}`
    );
  }

  const outputText =
    extractOutputText(
      data
    );

  if (!outputText) {
    throw new Error(
      "A OpenAI não retornou texto estruturado."
    );
  }

  let result;

  try {
    result =
      JSON.parse(
        outputText
      );
  } catch {
    throw new Error(
      "Não foi possível interpretar o JSON da IA."
    );
  }

  return validateAIResult(
    result,
    priceCandidates,
    discountCandidates
  );
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

    let parsedInput;

    try {
      parsedInput =
        new URL(url);
    } catch {
      return res
        .status(400)
        .json({
          error:
            "Link inválido.",
        });
    }

    const allowedHosts = [
      "meli.la",
      "www.meli.la",
      "mercadolivre.com.br",
      "www.mercadolivre.com.br",
      "mercadolivre.com",
      "www.mercadolivre.com",
    ];

    if (
      !allowedHosts.includes(
        parsedInput.hostname
          .toLowerCase()
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Use um link do Mercado Livre.",
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
      Array.isArray(
        image
      )
    ) {
      image =
        image[0];
    }

    if (
      image &&
      typeof image ===
        "object"
    ) {
      image =
        image.url ||
        image.contentUrl ||
        null;
    }

    const itemId =
      extractItemId(
        html
      ) ||
      extractItemId(
        finalUrl
      );

    const freeShipping =
      /frete gr[aá]tis/i.test(
        stripHtml(html)
      ) ||
      /"free_shipping"\s*:\s*true/i.test(
        html
      );

    let jsonLdPrice =
      null;

    if (
      jsonLd?.offers
    ) {
      if (
        Array.isArray(
          jsonLd.offers
        )
      ) {
        for (
          const offer of
            jsonLd.offers
        ) {
          const candidate =
            normalizePrice(
              offer?.price
            );

          if (
            candidate !==
            null
          ) {
            jsonLdPrice =
              candidate;
            break;
          }
        }
      } else {
        jsonLdPrice =
          normalizePrice(
            jsonLd.offers
              ?.price
          );
      }
    }

    const priceEvidence =
      extractPriceEvidence(
        html
      );

    const discountEvidence =
      extractDiscountEvidence(
        html
      );

    const priceCandidates =
      uniqueNumbers([
        ...priceEvidence.map(
          (item) =>
            item.value
        ),
        jsonLdPrice,
      ]);

    const discountCandidates = [
      ...new Set(
        discountEvidence.map(
          (item) =>
            item.value
        )
      ),
    ];

    let priceResult;
    let priceSource =
      "ai";
    let aiError =
      null;

    try {
      priceResult =
        await analyzeWithAI({
          title,
          itemId,
          finalUrl,
          jsonLdPrice,
          priceEvidence,
          discountEvidence,
          freeShipping,
        });

      /*
       * Se a IA ficou muito insegura,
       * preferimos marcar isso no debug.
       * Ainda usamos a resposta,
       * pois ela foi validada contra
       * candidatos reais.
       */
      if (
        priceResult
          .confidence <
        0.45
      ) {
        priceSource =
          "ai_low_confidence";
      }
    } catch (error) {
      console.error(
        "Falha na análise com IA:",
        error
      );

      aiError =
        error?.message ||
        "Erro desconhecido";

      priceSource =
        "fallback";

      priceResult =
        fallbackSelection(
          priceEvidence,
          discountEvidence,
          jsonLdPrice
        );
    }

    /*
     * Validação matemática final.
     */
    if (
      priceResult
        .original_price !==
        null &&
      priceResult.price !==
        null
    ) {
      const calculatedDiscount =
        calculateDiscount(
          priceResult
            .original_price,
          priceResult.price
        );

      /*
       * Se não veio desconto da IA
       * mas o par é válido,
       * calculamos.
       */
      if (
        priceResult
          .discount_percent ===
          null
      ) {
        priceResult
          .discount_percent =
          calculatedDiscount;
      }
    }

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
            priceResult
              .price ??
            null,

          original_price:
            priceResult
              .original_price ??
            null,

          discount_percent:
            priceResult
              .discount_percent ??
            null,

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
         * TEMPORÁRIO:
         * deixe esse debug enquanto
         * fazemos os primeiros testes.
         */
        debug: {
          price_source:
            priceSource,

          ai_confidence:
            priceResult
              .confidence ??
            null,

          ai_error:
            aiError,

          json_ld_price:
            jsonLdPrice,

          price_candidates:
            priceCandidates
              .slice(0, 30),

          discount_candidates:
            discountCandidates
              .slice(0, 20),
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