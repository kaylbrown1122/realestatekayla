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

  function looksLikeHtml(s) {
    return /^\s*</.test(String(s || ""));
  }

  function safeUpstreamDetail(raw, status) {
    if (looksLikeHtml(raw)) {
      return (
        "Google returned a web page (HTTP " +
        (status || "?") +
        ") instead of JSON. " +
        "In Apps Script: Deploy the Web app with Who has access = Anyone. " +
        "If you use Google Workspace, an admin may need to allow external web app execution."
      );
    }
    return String(raw || "").slice(0, 200);
  }

  /**
   * POST to Apps Script /exec following 3xx with another POST (same body).
   * Default fetch follows 302 with GET and drops the JSON body.
   */
  async function postToGasExec(url, headers, body) {
    let current = url;
    let upstream;
    for (let hop = 0; hop < 8; hop++) {
      upstream = await fetch(current, {
        method: "POST",
        headers,
        body,
        redirect: "manual"
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        const loc = upstream.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).href;
        continue;
      }
      break;
    }
    return upstream;
  }

  async function tryOnce(contentType, requestBody) {
    const headers =
      contentType === "json"
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
    const upstream = await postToGasExec(webhookUrl, headers, requestBody);
    const raw = await upstream.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }
    return { upstream, raw, parsed };
  }

  try {
    const bodyStr = JSON.stringify(payload);

    let { upstream, raw, parsed } = await tryOnce("json", bodyStr);

    const appLogicalFailure =
      parsed && typeof parsed === "object" && parsed.ok === false;
    const tryForm =
      !appLogicalFailure &&
      (!upstream.ok || looksLikeHtml(raw) || parsed === null);

    // Retry as form POST: some Google edges handle this more reliably than raw JSON.
    // Apps Script must read e.parameter.data (see comment at bottom of this file).
    if (tryForm) {
      const formBody = new URLSearchParams();
      formBody.set("data", bodyStr);
      ({ upstream, raw, parsed } = await tryOnce("form", formBody.toString()));
    }

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: "upstream_rejected",
        status: upstream.status,
        detail: safeUpstreamDetail(raw, upstream.status)
      });
    }

    if (!parsed && looksLikeHtml(raw)) {
      return res.status(502).json({
        ok: false,
        error: "upstream_html_not_json",
        detail: safeUpstreamDetail(raw, upstream.status)
      });
    }

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

/*
Apps Script: accept JSON body OR form field `data` (same JSON string).

Replace your payload line with:

function parsePayload_(e) {
  if (e.parameter && e.parameter.data) {
    try { return JSON.parse(e.parameter.data); } catch (_) {}
  }
  try {
    return JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (_) {
    return {};
  }
}

Then in doPost: const payload = parsePayload_(e);
*/
