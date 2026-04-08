module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "lead-submit",
      webhookConfigured: !!process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL,
      tokenConfigured: !!process.env.GOOGLE_SHEETS_WEBHOOK_TOKEN
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const webhookUrl = process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL;
  const webhookToken = process.env.GOOGLE_SHEETS_WEBHOOK_TOKEN || "";

  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: "webhook_not_configured" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const payload = {
    formType: body.formType || "",
    timestamp: body.timestamp || new Date().toISOString(),
    pageUrl: body.pageUrl || "",
    source: body.source || "",
    token: webhookToken,
    name: body.name || "",
    email: body.email || "",
    phone: body.phone || "",
    interest: body.interest || "",
    message: body.message || "",
    consent: body.consent || ""
  };

  try {
    const upstream = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const raw = await upstream.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: "upstream_rejected",
        status: upstream.status,
        detail: raw.slice(0, 200)
      });
    }

    // Google Apps Script often returns HTTP 200 even for logical errors.
    if (parsed && parsed.ok === false) {
      return res.status(502).json({
        ok: false,
        error: "upstream_app_error",
        detail: (parsed.error || "unknown").toString().slice(0, 200)
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ ok: false, error: "upstream_unreachable" });
  }
};
