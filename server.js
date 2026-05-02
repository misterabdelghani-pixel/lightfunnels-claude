import express from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

const LF_SECRET = process.env.LF_APP_SECRET;
const LF_CLIENT_ID = process.env.LF_CLIENT_ID;
const REDIRECT_URI = "https://lightfunnels-claude.onrender.com/callback";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const insights = [];
let accessToken = null;

app.use(express.json());

// ─── Home ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (accessToken) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:700px">
        <h2>✅ Claude Analyzer connected!</h2>
        <p style="color:#888">Ask Claude anything about your store:</p>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:1.5rem">
          <a href="/ask?q=How many orders did I get today per funnel?" style="color:#5DCAA5;font-size:15px" target="_blank">→ Orders per funnel today</a>
          <a href="/ask?q=Which funnel made the most revenue this week?" style="color:#5DCAA5;font-size:15px" target="_blank">→ Best funnel this week</a>
          <a href="/ask?q=Which product has the most refunds?" style="color:#5DCAA5;font-size:15px" target="_blank">→ Refund analysis</a>
          <a href="/ask?q=Compare this month vs last month revenue" style="color:#5DCAA5;font-size:15px" target="_blank">→ Month vs last month</a>
          <a href="/ask?q=What is my total revenue today?" style="color:#5DCAA5;font-size:15px" target="_blank">→ Total revenue today</a>
        </div>
      </body></html>
    `);
  }

  // Correct LightFunnels OAuth URL
  const authUrl = `https://app.lightfunnels.com/admin/oauth?client_id=${LF_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=orders,funnels,products&state=claude123`;

  res.send(`
    <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:500px;text-align:center">
      <h2>Claude Analyzer</h2>
      <p style="color:#888;margin-bottom:2rem">Connect your LightFunnels store to Claude</p>
      <a href="${authUrl}" target="_blank" style="
        display:inline-block;background:#1D9E75;color:white;
        padding:14px 32px;border-radius:8px;text-decoration:none;
        font-size:16px;font-weight:500;">Connect my store →</a>
      <p style="color:#555;font-size:12px;margin-top:1.5rem">Opens a new tab. After approving, come back and refresh.</p>
    </body></html>
  `);
});

// ─── OAuth callback ─────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  console.log("Callback hit! Query:", JSON.stringify(req.query));
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code. Got: " + JSON.stringify(req.query));

  try {
    // LightFunnels requires Basic auth with base64(client_id:client_secret)
    const credentials = Buffer.from(`${LF_CLIENT_ID}:${LF_SECRET}`).toString("base64");

    const tokenRes = await fetch("https://api.lightfunnels.com/api/access_token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code }).toString(),
    });

    const data = await tokenRes.json();
    console.log("Token response:", JSON.stringify(data));

    if (data.access_token) {
      accessToken = data.access_token;
      console.log("✅ Access token stored!");
      return res.send(`
        <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;text-align:center">
          <h2>✅ Connected!</h2>
          <p>Your store is now linked to Claude.</p>
          <p style="color:#888;margin-bottom:1.5rem">Close this tab and go back to Claude Analyzer.</p>
          <a href="/ask?q=How many orders per funnel today?" 
             style="display:inline-block;background:#1D9E75;color:white;padding:12px 24px;border-radius:8px;text-decoration:none">
            Ask Claude now →
          </a>
        </body></html>
      `);
    } else {
      res.send(`
        <html><body style="background:#0f0f0f;color:white;padding:2rem;font-family:sans-serif">
          <h3>Auth response (send to Claude):</h3>
          <pre style="background:#1a1a1a;padding:1rem;border-radius:8px;overflow:auto">${JSON.stringify(data, null, 2)}</pre>
        </body></html>
      `);
    }
  } catch (err) {
    console.error("Token error:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// ─── GraphQL helper ─────────────────────────────────────────────────────────
async function queryLF(query, variables = {}) {
  if (!accessToken) throw new Error("Not connected. Please authorize first.");
  const res = await fetch("https://services.lightfunnels.com/api/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// ─── Ask Claude ─────────────────────────────────────────────────────────────
app.get("/ask", async (req, res) => {
  const question = req.query.q;
  if (!question) return res.status(400).send("Add ?q=your question");
  try {
    const ordersData = await queryLF(`query { orders(first:250) { edges { node { id created_at total_price financial_status funnel { name } line_items { edges { node { title quantity price } } } } } } }`);
    const orders = ordersData?.data?.orders?.edges?.map(e => e.node) || [];
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 800,
      messages: [{ role: "user", content: `Sales analyst for LightFunnels store. ${orders.length} orders: ${JSON.stringify(orders, null, 2)}. Today: ${new Date().toISOString().split("T")[0]}. Question: ${question}. Answer with specific numbers and funnel names.` }],
    });
    const answer = response.content.map(b => b.text || "").join("");
    res.send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:800px">
      <p style="color:#888;font-size:13px">Question</p><h3>${question}</h3>
      <p style="color:#888;font-size:13px;margin-top:1.5rem">Claude's answer</p>
      <div style="background:#1a1a1a;padding:1.5rem;border-radius:8px;line-height:1.8;white-space:pre-wrap">${answer}</div>
      <p style="margin-top:1.5rem"><a href="/" style="color:#5DCAA5">← Ask another question</a></p>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`<html><body style="background:#0f0f0f;color:white;padding:2rem">Error: ${err.message}<br><a href="/" style="color:#5DCAA5">← Back</a></body></html>`);
  }
});

// ─── Webhook ────────────────────────────────────────────────────────────────
function verifyWebhook(req) {
  const hmac = req.headers["lightfunnels-hmac"];
  if (!hmac) return false;
  return crypto.createHmac("sha256", LF_SECRET).update(JSON.stringify(req.body), "utf8").digest("base64") === hmac;
}

app.post("/webhook", async (req, res) => {
  if (!verifyWebhook(req)) return res.status(403).json({ error: "Invalid signature" });
  const { type, data } = req.body;
  if (!["order/confirmed","order/refunded","order/cancelled","checkout/created","contact/signup"].includes(type))
    return res.status(200).json({ message: "Not tracked" });
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 300,
      messages: [{ role: "user", content: `Sales analyst. Event: ${type}. Data: ${JSON.stringify(data)}. Respond ONLY with JSON: {"summary":"...","insight":"...","flag":"none|warning|opportunity","flagReason":"..."}` }],
    });
    const analysis = JSON.parse(response.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim());
    insights.unshift({ id: Date.now(), timestamp: new Date().toISOString(), eventType: type, analysis });
    if (insights.length > 100) insights.pop();
    res.status(200).json({ received: true, analysis });
  } catch (err) { res.status(500).json({ error: "Analysis failed" }); }
});

app.get("/insights", (req, res) => res.json({ total: insights.length, insights }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`LightFunnels × Claude running on port ${PORT}`));
