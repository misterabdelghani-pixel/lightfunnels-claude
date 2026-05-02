import express from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Config ────────────────────────────────────────────────────────────────
// Set these as environment variables on your hosting platform:
//   LF_APP_SECRET   → your LightFunnels app client secret
//   ANTHROPIC_API_KEY → your Anthropic API key
const LF_SECRET = process.env.LF_APP_SECRET;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory store (replace with a DB for production) ────────────────────
const insights = [];

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Webhook verification ──────────────────────────────────────────────────
function verifyWebhook(req) {
  const hmac = req.headers["lightfunnels-hmac"];
  if (!hmac) return false;
  const calculated = crypto
    .createHmac("sha256", LF_SECRET)
    .update(JSON.stringify(req.body), "utf8")
    .digest("base64");
  return calculated === hmac;
}

// ─── Claude analysis ───────────────────────────────────────────────────────
async function analyzeWithClaude(eventType, data) {
  const prompt = `You are a sales analyst for a LightFunnels e-commerce store.
A new store event just occurred. Analyze it and respond ONLY with a JSON object (no markdown, no backticks):
{
  "summary": "one sentence summary of what happened",
  "insight": "one specific, actionable insight or observation",
  "flag": "none" | "warning" | "opportunity",
  "flagReason": "brief reason if flagged, otherwise empty string"
}

Event type: ${eventType}
Event data:
${JSON.stringify(data, null, 2)}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.map((b) => b.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── POST /webhook — receives LightFunnels events ─────────────────────────
app.post("/webhook", async (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(403).json({ error: "Invalid webhook signature" });
  }

  const { type, data } = req.body;

  // Only analyze these event types (add more as needed)
  const supportedEvents = [
    "order/confirmed",
    "order/refunded",
    "order/cancelled",
    "checkout/created",
    "contact/signup",
  ];

  if (!supportedEvents.includes(type)) {
    return res.status(200).json({ message: "Event type not tracked" });
  }

  try {
    const analysis = await analyzeWithClaude(type, data);

    const record = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      eventType: type,
      analysis,
      rawData: data,
    };

    insights.unshift(record); // newest first
    if (insights.length > 100) insights.pop(); // keep last 100

    console.log(`[${type}] ${analysis.summary}`);
    if (analysis.flag !== "none") {
      console.warn(`  FLAG (${analysis.flag}): ${analysis.flagReason}`);
    }

    res.status(200).json({ received: true, analysis });
  } catch (err) {
    console.error("Claude analysis error:", err.message);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// ─── GET /insights — view all logged insights ─────────────────────────────
app.get("/insights", (req, res) => {
  res.json({
    total: insights.length,
    insights: insights.map((i) => ({
      id: i.id,
      timestamp: i.timestamp,
      eventType: i.eventType,
      summary: i.analysis.summary,
      insight: i.analysis.insight,
      flag: i.analysis.flag,
      flagReason: i.analysis.flagReason,
    })),
  });
});

// ─── GET /insights/flags — only flagged events ────────────────────────────
app.get("/insights/flags", (req, res) => {
  const flagged = insights.filter((i) => i.analysis.flag !== "none");
  res.json({ total: flagged.length, flagged });
});

// ─── GET /health — deployment health check ────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LightFunnels × Claude server running on port ${PORT}`);
  console.log(`  POST /webhook    — receives LightFunnels events`);
  console.log(`  GET  /insights   — view all AI insights`);
  console.log(`  GET  /insights/flags — view flagged events only`);
});
