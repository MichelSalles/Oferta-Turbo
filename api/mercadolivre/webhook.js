export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      service: "Oferta Turbo Mercado Livre Webhook"
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    console.log("Mercado Livre webhook:", JSON.stringify(req.body));

    // Responde rápido ao Mercado Livre.
    return res.status(200).json({
      received: true
    });
  } catch (error) {
    console.error("Webhook error:", error);

    return res.status(200).json({
      received: true
    });
  }
}