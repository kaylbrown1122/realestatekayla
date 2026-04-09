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
    const bodyStr = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };

    // Apps Script /exec often responds with 302 to script.googleusercontent.com.
    // Default fetch may follow with GET and drop the POST body, returning HTML (login/marketing page).
    let upstream;
    let url = webhookUrl;
    for (let hop = 0; hop < 5; hop++) {
      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        redirect: "manual"
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        const loc = upstream.headers.get("location");
        if (!loc) break;
        url = new URL(loc, url).href;
        continue;
      }
      break;
    }

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

    if (!parsed && /^\s*</.test(raw)) {
      return res.status(502).json({
        ok: false,
        error: "upstream_html_not_json",
        detail:
          "Google returned a web page instead of JSON. Redeploy the Web app as Anyone, or retry after fixing Workspace access."
      });
    }

    // Google Apps Script Web Apps often return HTTP 200 with { ok: false } in the body.
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
