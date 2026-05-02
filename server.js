import express from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

const LF_SECRET = process.env.LF_APP_SECRET;
const LF_CLIENT_ID = process.env.LF_CLIENT_ID;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const insights = [];
let accessToken = null;

app.use(express.json());

// ─── Get token using client credentials ────────────────────────────────────
async function getToken() {
  if (accessToken) return accessToken;
  const res = await fetch("https://services.lightfunnels.com/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: LF_CLIENT_ID,
      client_secret: LF_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const data = await res.json();
  console.log("Token response:", JSON.stringify(data));
  if (data.access_token) {
    accessToken = data.access_token;
    console.log("✅ Token obtained via client credentials");
  }
  return accessToken;
}

// Try to get token on startup
getToken().catch(e => console.log("Startup token error:", e.message));

// ─── GraphQL helper ─────────────────────────────────────────────────────────
async function queryLF(query, variables = {}) {
  const token = await getToken();
  if (!token) throw new Error("Could not obtain access token.");
  const res = await fetch("https://services.lightfunnels.com/api/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// ─── Home page ──────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  const token = await getToken();
  res.send(`
    <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:700px">
      <h2>${token ? "✅ Claude Analyzer connected" : "⚠️ Not connected yet"}</h2>
      ${token ? `
      <p>Ask Claude anything about your store:</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:1rem">
        <a href="/ask?q=How many orders did I get today per funnel?" style="color:#5DCAA5">→ Orders per funnel today</a>
        <a href="/ask?q=Which funnel made the most revenue this week?" style="color:#5DCAA5">→ Best funnel this week</a>
        <a href="/ask?q=Which product has the most refunds?" style="color:#5DCAA5">→ Refund analysis</a>
        <a href="/ask?q=Compare this month vs last month revenue" style="color:#5DCAA5">→ Month vs last month</a>
        <a href="/ask?q=What is my total revenue today?" style="color:#5DCAA5">→ Total revenue today</a>
      </div>
      ` : `<p>Token not available. Check your LF_CLIENT_ID and LF_APP_SECRET on Render.</p>`}
    </body></html>
  `);
});

// ─── Ask Claude ─────────────────────────────────────────────────────────────
app.get("/ask", async (req, res) => {
  const question = req.query.q;
  if (!question) return res.status(400).send("Add ?q=your question");

  try {
    const ordersData = await queryLF(`
      query {
        orders(first: 250) {
          edges {
            node {
              id
              created_at
              total_price
              financial_status
              funnel { name }
              line_items { edges { node { title quantity price } } }
            }
          }
        }
      }
    `);

    console.log("Orders response:", JSON.stringify(ordersData).slice(0, 300));
    const orders = ordersData?.data?.orders?.edges?.map(e => e.node) || [];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are a sales analyst for a LightFunnels store.
Order data (${orders.length} orders): ${JSON.stringify(orders, null, 2)}
Question: ${question}
Today's date: ${new Date().toISOString().split("T")[0]}
Answer clearly with specific numbers and funnel names.`
      }],
    });

    const answer = response.content.map(b => b.text || "").join("");

    res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:800px">
        <p style="color:#888;font-size:13px">Question</p>
        <h3 style="margin-top:4px">${question}</h3>
        <p style="color:#888;font-size:13px;margin-top:1.5rem">Claude's answer</p>
        <div style="background:#1a1a1a;padding:1.5rem;border-radius:8px;line-height:1.8;white-space:pre-wrap">${answer}</div>
        <p style="margin-top:1.5rem"><a href="/" style="color:#5DCAA5">← Back</a></p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<html><body style="background:#0f0f0f;color:white;padding:2rem">
      Error: ${err.message}<br><a href="/" style="color:#5DCAA5">← Back</a>
    </body></html>`);
  }
});

// ─── Webhook ────────────────────────────────────────────────────────────────
function verifyWebhook(req) {
  const hmac = req.headers["lightfunnels-hmac"];
  if (!hmac) return false;
  const calculated = crypto.createHmac("sha256", LF_SECRET).update(JSON.stringify(req.body), "utf8").digest("base64");
  return calculated === hmac;
}

app.post("/webhook", async (req, res) => {
  if (!verifyWebhook(req)) return res.status(403).json({ error: "Invalid signature" });
  const { type, data } = req.body;
  const supported = ["order/confirmed","order/refunded","order/cancelled","checkout/created","contact/signup"];
  if (!supported.includes(type)) return res.status(200).json({ message: "Not tracked" });
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: `Sales analyst. Event: ${type}. Data: ${JSON.stringify(data)}. Respond ONLY with JSON: {"summary":"...","insight":"...","flag":"none|warning|opportunity","flagReason":"..."}` }],
    });
    const analysis = JSON.parse(response.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim());
    insights.unshift({ id: Date.now(), timestamp: new Date().toISOString(), eventType: type, analysis });
    if (insights.length > 100) insights.pop();
    res.status(200).json({ received: true, analysis });
  } catch (err) {
    res.status(500).json({ error: "Analysis failed" });
  }
});

app.get("/insights", (req, res) => res.json({ total: insights.length, insights }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`LightFunnels × Claude running on port ${PORT}`));
