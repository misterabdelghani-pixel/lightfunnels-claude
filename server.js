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

// ─── Step 1: LightFunnels loads this — redirect to OAuth ───────────────────
app.get("/", (req, res) => {
  if (accessToken) {
    return res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white">
        <h2>✅ Claude Analyzer connected</h2>
        <p>Your store is linked. Ask Claude anything about your orders:</p>
        <div style="display:flex;flex-direction:column;gap:10px;max-width:600px;margin-top:1rem">
          <a href="/ask?q=How many orders did I get today per funnel?" style="color:#5DCAA5">→ Orders per funnel today</a>
          <a href="/ask?q=Which funnel made the most revenue this week?" style="color:#5DCAA5">→ Best funnel this week</a>
          <a href="/ask?q=Which product has the most refunds?" style="color:#5DCAA5">→ Refund analysis</a>
          <a href="/ask?q=Compare this month vs last month revenue" style="color:#5DCAA5">→ Month comparison</a>
        </div>
      </body></html>
    `);
  }

  const authUrl = `https://app.lightfunnels.com/oauth/authorize?client_id=${LF_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
  res.redirect(authUrl);
});

// ─── Step 2: LightFunnels redirects here with ?code= ──────────────────────
app.get("/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }

  try {
    const tokenRes = await fetch("https://services.lightfunnels.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: LF_CLIENT_ID,
        client_secret: LF_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();
    console.log("Token response:", JSON.stringify(tokenData));

    if (tokenData.access_token) {
      accessToken = tokenData.access_token;
      console.log("✅ Access token stored.");
      res.redirect("/?connected=true");
    } else {
      res.status(400).send("Token exchange failed: " + JSON.stringify(tokenData));
    }
  } catch (err) {
    console.error("Token error:", err.message);
    res.status(500).send("Token exchange error: " + err.message);
  }
});

// ─── GraphQL helper ─────────────────────────────────────────────────────────
async function queryLF(query, variables = {}) {
  if (!accessToken) throw new Error("Not connected. Please visit the app and authorize.");
  const res = await fetch("https://services.lightfunnels.com/api/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// ─── GET /ask?q=question ────────────────────────────────────────────────────
app.get("/ask", async (req, res) => {
  const question = req.query.q;
  if (!question) return res.status(400).send("Add ?q=your question to the URL");

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

    const orders = ordersData?.data?.orders?.edges?.map(e => e.node) || [];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are a sales analyst for a LightFunnels store.
Order data (${orders.length} orders): ${JSON.stringify(orders, null, 2)}
Question: ${question}
Answer clearly with specific numbers and funnel names. Today's date is ${new Date().toISOString().split('T')[0]}.`
      }],
    });

    const answer = response.content.map(b => b.text || "").join("");

    res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:white;max-width:800px">
        <p style="color:#888;font-size:13px">Question</p>
        <h3 style="margin-top:4px;color:white">${question}</h3>
        <p style="color:#888;font-size:13px;margin-top:1.5rem">Claude's answer</p>
        <div style="background:#1a1a1a;padding:1.5rem;border-radius:8px;line-height:1.8;white-space:pre-wrap;color:white">${answer}</div>
        <p style="margin-top:1.5rem">
          <a href="/" style="color:#5DCAA5">← Back to dashboard</a>
        </p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<html><body style="background:#0f0f0f;color:white;padding:2rem;font-family:sans-serif">
      <p>Error: ${err.message}</p><a href="/" style="color:#5DCAA5">← Back</a>
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

async function analyzeWithClaude(eventType, data) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{ role: "user", content: `Sales analyst. Event: ${eventType}. Data: ${JSON.stringify(data)}. Respond ONLY with JSON (no markdown): {"summary":"...","insight":"...","flag":"none|warning|opportunity","flagReason":"..."}` }],
  });
  return JSON.parse(response.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim());
}

app.post("/webhook", async (req, res) => {
  if (!verifyWebhook(req)) return res.status(403).json({ error: "Invalid signature" });
  const { type, data } = req.body;
  const supported = ["order/confirmed","order/refunded","order/cancelled","checkout/created","contact/signup"];
  if (!supported.includes(type)) return res.status(200).json({ message: "Not tracked" });
  try {
    const analysis = await analyzeWithClaude(type, data);
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
