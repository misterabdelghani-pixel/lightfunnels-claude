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
          <a href="/ask?q=How many orders did I get today per funnel?" style="color:#5DCAA5;font-size:15px">→ Orders per funnel today</a>
          <a href="/ask?q=Which funnel made the most revenue this week?" style="color:#5DCAA5;font-size:15px">→ Best funnel this week</a>
          <a href="/ask?q=Which product has the most refunds?" style="color:#5DCAA5;font-size:15px">→ Refund analysis</a>
          <a href="/ask?q=Compare this month vs last month revenue" style="color:#5DCAA5;font-size:15px">→ Month vs last month</a>
          <a href="/ask?q=What is my total revenue today?" style="color:#5DCAA5;font-size:15px">→ Total revenue today</a>
          <a href="/ask?q=Show me all orders from the last 7 days with funnel names and totals" style="color:#5DCAA5;font-size:15px">→ Last 7 days summary</a>
        </div>
      </body></html>
    `);
  }

  const authUrl = `https://app.lightfunnels.com/admin/oauth?client_id=${LF_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=orders,funnels,products&state=claude123`;
  res.send(`
    <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:500px;text-align:center">
      <h2>Claude Analyzer</h2>
      <p style="color:#888;margin-bottom:2rem">Connect your LightFunnels store to Claude</p>
      <a href="${authUrl}" target="_blank" style="display:inline-block;background:#1D9E75;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:500;">Connect my store →</a>
      <p style="color:#555;font-size:12px;margin-top:1.5rem">Opens a new tab. After approving, come back and refresh.</p>
    </body></html>
  `);
});

// ─── OAuth callback ─────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code.");
  try {
    const credentials = Buffer.from(`${LF_CLIENT_ID}:${LF_SECRET}`).toString("base64");
    const tokenRes = await fetch("https://api.lightfunnels.com/api/access_token", {
      method: "POST",
      headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }).toString(),
    });
    const data = await tokenRes.json();
    if (data.access_token) {
      accessToken = data.access_token;
      return res.send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;text-align:center">
        <h2>✅ Connected!</h2><p>Close this tab and go back to Claude Analyzer.</p>
        <a href="/" style="color:#5DCAA5">Or ask a question now →</a>
      </body></html>`);
    }
    res.send(`<pre style="background:#0f0f0f;color:white;padding:2rem">${JSON.stringify(data, null, 2)}</pre>`);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ─── GraphQL helper ─────────────────────────────────────────────────────────
async function queryLF(gqlQuery, variables = {}) {
  if (!accessToken) throw new Error("Not connected.");
  const res = await fetch("https://services.lightfunnels.com/api/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query: gqlQuery, variables }),
  });
  return res.json();
}

// ─── Fetch funnels to map funnel_id → name ──────────────────────────────────
async function getFunnelMap() {
  try {
    const data = await queryLF(`query { funnels(first:100, query:"") { edges { node { _id name } } } }`);
    const funnels = data?.data?.funnels?.edges?.map(e => e.node) || [];
    const map = {};
    funnels.forEach(f => { map[f._id] = f.name; });
    return map;
  } catch {
    return {};
  }
}

// ─── Ask Claude ─────────────────────────────────────────────────────────────
app.get("/ask", async (req, res) => {
  const question = req.query.q;
  if (!question) return res.status(400).send("Add ?q=your question");

  try {
    // Fetch orders
    const ordersData = await queryLF(`
      query {
        orders(first: 250, query: "") {
          edges {
            node {
              _id
              created_at
              total
              subtotal
              financial_status
              fulfillment_status
              funnel_id
              name
              email
            }
          }
        }
      }
    `);

    const orders = ordersData?.data?.orders?.edges?.map(e => e.node) || [];

    // Fetch funnel names
    const funnelMap = await getFunnelMap();

    // Attach funnel names to orders
    const enrichedOrders = orders.map(o => ({
      ...o,
      funnel_name: funnelMap[o.funnel_id] || `Funnel ${o.funnel_id}`,
    }));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `You are a sales analyst for a LightFunnels e-commerce store.
Here are ${enrichedOrders.length} orders with funnel names: ${JSON.stringify(enrichedOrders, null, 2)}
Today's date: ${new Date().toISOString().split("T")[0]}
Question: ${question}
Answer clearly with specific numbers, funnel names, and totals. Currency is in the store's local currency.`
      }],
    });

    const answer = response.content.map(b => b.text || "").join("");

    res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:800px">
        <p style="color:#888;font-size:13px">Question</p>
        <h3 style="margin-top:4px">${question}</h3>
        <p style="color:#888;font-size:13px;margin-top:1.5rem">Claude's answer</p>
        <div style="background:#1a1a1a;padding:1.5rem;border-radius:8px;line-height:1.8;white-space:pre-wrap">${answer}</div>
        <p style="margin-top:1.5rem"><a href="/" style="color:#5DCAA5">← Ask another question</a></p>
      </body></html>
    `);
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
