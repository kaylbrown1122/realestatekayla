module.exports = async function handler(req, res) {
  const slackUrl = (process.env.SLACK_WEBHOOK_URL || "").trim().replace(/^["']|["']$/g, "");
  const googleUrl = (process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL || "").trim();
  const webhookToken = process.env.GOOGLE_SHEETS_WEBHOOK_TOKEN || "";

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "lead-submit",
      slackConfigured: !!slackUrl,
      googleConfigured: !!googleUrl,
      webhookConfigured: !!googleUrl,
      tokenConfigured: !!webhookToken
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!slackUrl && !googleUrl) {
    return res.status(503).json({
      ok: false,
      error: "webhook_not_configured",
      detail: "Set SLACK_WEBHOOK_URL and/or GOOGLE_APPS_SCRIPT_WEBHOOK_URL in Vercel."
    });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch (_) {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const fields = {
    formType: body.formType || "",
    timestamp: body.timestamp || new Date().toISOString(),
    pageUrl: body.pageUrl || "",
    source: body.source || "",
    name: body.name || "",
    email: body.email || "",
    phone: body.phone || "",
    interest: body.interest || "",
    message: body.message || "",
    consent: body.consent || ""
  };

  const googlePayload = {
    ...fields,
    token: webhookToken
  };

  function looksLikeHtml(s) {
    return /^\s*</.test(String(s || ""));
  }

  function safeUpstreamDetail(raw, status) {
    if (looksLikeHtml(raw)) {
      return (
        "Google returned a web page (HTTP " +
        (status || "?") +
        ") instead of JSON. Deploy Web app as Anyone, or use Slack only (SLACK_WEBHOOK_URL)."
      );
    }
    return String(raw || "").slice(0, 200);
  }

  function slackPlain(s) {
    return String(s || "")
      .replace(/[*_`[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
  }

  async function sendSlack() {
    if (!/^https:\/\/hooks\.slack\.com\//i.test(slackUrl)) {
      return {
        ok: false,
        detail:
          "SLACK_WEBHOOK_URL must start with https://hooks.slack.com/ (check Vercel for typos, spaces, or stray quotes)."
      };
    }

    const text = [
      "*Real Estate Kayla — new form submission*",
      "*Type:* " + (slackPlain(fields.formType) || "(none)"),
      "*Name:* " + slackPlain(fields.name),
      "*Email:* " + slackPlain(fields.email),
      "*Phone:* " + slackPlain(fields.phone),
      "*Interest:* " + slackPlain(fields.interest),
      "*Source:* " + slackPlain(fields.source),
      "*Page:* " + slackPlain(fields.pageUrl),
      "*When:* " + slackPlain(fields.timestamp),
      fields.message ? "*Message:*\n" + slackPlain(fields.message) : "",
      fields.consent ? "*Consent:* " + slackPlain(fields.consent) : ""
    ]
      .filter(Boolean)
      .join("\n");

    let upstream;
    let raw;
    try {
      upstream = await fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      raw = await upstream.text();
    } catch (err) {
      return {
        ok: false,
        detail: (err && err.message ? err.message : String(err)).slice(0, 200)
      };
    }
    if (!upstream.ok) {
      return {
        ok: false,
        detail: raw ? raw.slice(0, 200) : "HTTP " + upstream.status
      };
    }
    if (raw === "ok" || raw === "") {
      return { ok: true };
    }
    try {
      const j = JSON.parse(raw);
      if (j.ok === false) {
        return { ok: false, detail: (j.error || raw).slice(0, 200) };
      }
    } catch (_) {}
    return { ok: true };
  }

  async function postToGasExec(url, headers, requestBody) {
    let current = url;
    let upstream;
    for (let hop = 0; hop < 8; hop++) {
      upstream = await fetch(current, {
        method: "POST",
        headers,
        body: requestBody,
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

  async function tryGoogleOnce(contentType, requestBody) {
    const headers =
      contentType === "json"
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
    const upstream = await postToGasExec(googleUrl, headers, requestBody);
    const raw = await upstream.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }
    return { upstream, raw, parsed };
  }

  async function sendGoogle() {
    const bodyStr = JSON.stringify(googlePayload);

    let { upstream, raw, parsed } = await tryGoogleOnce("json", bodyStr);

    const appLogicalFailure =
      parsed && typeof parsed === "object" && parsed.ok === false;
    const tryForm =
      !appLogicalFailure &&
      (!upstream.ok || looksLikeHtml(raw) || parsed === null);

    if (tryForm) {
      const formBody = new URLSearchParams();
      formBody.set("data", bodyStr);
      ({ upstream, raw, parsed } = await tryGoogleOnce("form", formBody.toString()));
    }

    if (!upstream.ok) {
      return {
        ok: false,
        detail: safeUpstreamDetail(raw, upstream.status),
        status: upstream.status
      };
    }

    if (!parsed && looksLikeHtml(raw)) {
      return { ok: false, detail: safeUpstreamDetail(raw, upstream.status) };
    }

    if (parsed && parsed.ok === false) {
      return {
        ok: false,
        detail: (parsed.error || "unknown").toString().slice(0, 200)
      };
    }

    return { ok: true };
  }

  try {
    // When Slack is configured, use it only. Google Apps Script often 401/405 on Workspace;
    // leaving GOOGLE_* env vars set was still calling Google and surfacing those errors.
    if (slackUrl) {
      const slackRes = await sendSlack();
      if (!slackRes.ok) {
        return res.status(502).json({
          ok: false,
          error: "slack_rejected",
          detail: slackRes.detail || "unknown"
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (googleUrl) {
      const googleRes = await sendGoogle();
      if (!googleRes.ok) {
        return res.status(502).json({
          ok: false,
          error: googleRes.detail ? "upstream_app_error" : "upstream_rejected",
          detail: googleRes.detail || "google_failed",
          status: googleRes.status
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return res.status(502).json({
      ok: false,
      error: "upstream_unreachable",
      detail: msg.slice(0, 200)
    });
  }
};

/*
Google Apps Script optional: accept JSON body OR form field `data`.

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
*/
