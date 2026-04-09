module.exports = async function handler(req, res) {
  function trimEnv(v) {
    return (v || "").trim().replace(/^["']|["']$/g, "");
  }

  let slackHookUrl = trimEnv(process.env.SLACK_WEBHOOK_URL);
  let slackBotToken = trimEnv(
    process.env.SLACK_BOT_TOKEN ||
      process.env.SLACK_TOKEN ||
      process.env.SLACK_OAUTH_TOKEN
  );
  const slackChannel = trimEnv(process.env.SLACK_CHANNEL);

  // Slack API tokens start with xox* (xoxb-, xoxp-, xoxe.xoxp-..., etc.), never http(s).
  // If one was pasted into SLACK_WEBHOOK_URL, treat it as SLACK_BOT_TOKEN.
  if (
    slackHookUrl &&
    /^xox/i.test(slackHookUrl) &&
    !/^https?:\/\//i.test(slackHookUrl)
  ) {
    slackBotToken = slackHookUrl;
    slackHookUrl = "";
  }

  const googleUrl = trimEnv(process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL);
  const webhookToken = process.env.GOOGLE_SHEETS_WEBHOOK_TOKEN || "";

  /** Easiest reliable path: https://formspree.io — create form, copy id from URL /f/XXXX */
  const formspreeId = trimEnv(process.env.FORMSPREE_FORM_ID);
  const formspreeOk = !!formspreeId && /^[a-zA-Z0-9_-]+$/.test(formspreeId);

  const slackHookOk =
    !!slackHookUrl && /^https:\/\/hooks\.slack\.com\//i.test(slackHookUrl);
  const slackBotOk = !!slackBotToken && !!slackChannel;
  const slackReady = slackHookOk || slackBotOk;

  function slackMisconfigDetail() {
    if (slackBotToken && !slackChannel) {
      return "You have a Slack token but SLACK_CHANNEL is missing. In Vercel add SLACK_CHANNEL with the channel ID (starts with C, e.g. C01234ABCDE — open channel in Slack → name → About → copy Channel ID). Redeploy.";
    }
    if (slackChannel && !slackBotToken && !slackHookOk) {
      return "SLACK_CHANNEL is set but no token. Add SLACK_BOT_TOKEN (your xox… token) or SLACK_WEBHOOK_URL (https://hooks.slack.com/...). Redeploy.";
    }
    const hookRaw = trimEnv(process.env.SLACK_WEBHOOK_URL);
    if (
      hookRaw &&
      !/^https:\/\/hooks\.slack\.com\//i.test(hookRaw) &&
      !/^xox/i.test(hookRaw)
    ) {
      return "SLACK_WEBHOOK_URL is not a valid Incoming Webhook (must start with https://hooks.slack.com/) and is not a Slack token (starts with xox). Fix the value or use SLACK_BOT_TOKEN + SLACK_CHANNEL.";
    }
    return "Easiest fix: set FORMSPREE_FORM_ID in Vercel (free at formspree.io). Or SLACK_WEBHOOK_URL / SLACK_BOT_TOKEN+SLACK_CHANNEL. Production + redeploy. GET /api/lead-submit shows what is set.";
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "lead-submit",
      formspreeConfigured: formspreeOk,
      slackConfigured: slackReady,
      slackWebhookConfigured: slackHookOk,
      slackBotConfigured: slackBotOk,
      slackBotTokenSet: !!slackBotToken,
      slackChannelSet: !!slackChannel,
      googleConfigured: !!googleUrl,
      webhookConfigured: !!googleUrl,
      tokenConfigured: !!webhookToken
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!formspreeOk && !slackReady && !googleUrl) {
    return res.status(503).json({
      ok: false,
      error: "webhook_not_configured",
      detail: slackMisconfigDetail()
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

  function formspreeSubjectLabel() {
    const ft = String(fields.formType || "").toLowerCase();
    const map = {
      buyer_questionnaire: "[BUYER QUESTIONNAIRE]",
      seller_questionnaire: "[SELLER QUESTIONNAIRE]",
      buy_sell_questionnaire: "[BUY + SELL QUESTIONNAIRE]",
      contact: "[CONTACT]",
      lead: "[LEAD — timed prompt]",
      vendor: "[VENDOR LIST SIGNUP]"
    };
    return (
      map[ft] ||
      "[" + (fields.formType || "FORM").toString().toUpperCase() + "]"
    );
  }

  async function sendFormspree() {
    const url = "https://formspree.io/f/" + encodeURIComponent(formspreeId);
    let upstream;
    let raw;
    const tag = formspreeSubjectLabel();
    let originHeader = "https://www.realestatekayla.com";
    try {
      const u = new URL(String(fields.pageUrl || ""));
      if (u.protocol === "https:" || u.protocol === "http:") {
        originHeader = u.origin;
      }
    } catch (_) {}
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // Formspree "restrict to domain" checks Origin; Vercel is server-side so send the page origin explicitly.
          Origin: originHeader,
          Referer: (fields.pageUrl && String(fields.pageUrl)) || originHeader + "/"
        },
        body: JSON.stringify({
          submission_tag: tag,
          formType: fields.formType,
          name: fields.name,
          email: fields.email,
          _replyto: fields.email,
          phone: fields.phone,
          interest: fields.interest,
          message: fields.message,
          consent: fields.consent,
          source: fields.source,
          pageUrl: fields.pageUrl,
          timestamp: fields.timestamp,
          _subject:
            tag +
            " Real Estate Kayla — " +
            (fields.name || "(no name)")
        })
      });
      raw = await upstream.text();
    } catch (err) {
      return {
        ok: false,
        detail: (err && err.message ? err.message : String(err)).slice(0, 200)
      };
    }

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      data = null;
    }

    // Formspree often returns HTTP 200 with { ok: false, errors: {...} } for validation — do not treat as success.
    if (data && data.ok === false) {
      const errs = data.errors;
      let errStr = data.error || "formspree_validation";
      if (errs && typeof errs === "object") {
        errStr = Object.keys(errs)
          .map((k) => k + ": " + (Array.isArray(errs[k]) ? errs[k].join(", ") : errs[k]))
          .join("; ")
          .slice(0, 400);
      }
      return { ok: false, detail: errStr };
    }

    if (upstream.ok && data && data.ok === true) {
      return { ok: true };
    }

    if (!upstream.ok) {
      try {
        if (data && data.error) {
          return { ok: false, detail: String(data.error).slice(0, 200) };
        }
      } catch (_) {}
      return { ok: false, detail: (raw || "formspree error").slice(0, 200) };
    }

    // 200 + non-JSON or legacy shape
    if (upstream.ok) {
      return { ok: true };
    }
    return { ok: false, detail: (raw || "formspree error").slice(0, 200) };
  }

  function looksLikeHtml(s) {
    return /^\s*</.test(String(s || ""));
  }

  function safeUpstreamDetail(raw, status) {
    if (looksLikeHtml(raw)) {
      return (
        "Google returned a web page (HTTP " +
        (status || "?") +
        ") instead of JSON. Deploy Web app as Anyone, or use Slack only."
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

  function buildSlackText() {
    return [
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
  }

  async function sendSlackWebhook(url) {
    const text = buildSlackText();
    let upstream;
    let raw;
    try {
      upstream = await fetch(url, {
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

  async function sendSlackBot(token, channel) {
    const text = buildSlackText();
    let upstream;
    let raw;
    try {
      upstream = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({
          channel: channel,
          text: text,
          mrkdwn: true
        })
      });
      raw = await upstream.text();
    } catch (err) {
      return {
        ok: false,
        detail: (err && err.message ? err.message : String(err)).slice(0, 200)
      };
    }
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {
        ok: false,
        detail: raw ? raw.slice(0, 200) : "Invalid Slack API response"
      };
    }
    if (!data.ok) {
      const err = String(data.error || "slack_api_error");
      let hint = err;
      if (err === "missing_scope") {
        hint =
          "missing_scope — Slack api.slack.com → Your App → OAuth & Permissions: under Bot Token Scopes add chat:write (optionally chat:write.public). If you use a user token (xoxp), add User Token Scope chat:write. Save, then Reinstall App to Workspace and put the new token in Vercel.";
      } else if (err === "not_in_channel") {
        hint =
          "not_in_channel — /invite your Slack app into that channel, or use chat:write.public with channel ID.";
      } else if (err === "channel_not_found") {
        hint =
          "channel_not_found — Check SLACK_CHANNEL is the channel ID (C…), not the display name.";
      } else if (err === "invalid_auth" || err === "token_revoked") {
        hint = err + " — Generate a new token in the Slack app and update Vercel.";
      }
      return { ok: false, detail: hint.slice(0, 400) };
    }
    return { ok: true };
  }

  async function sendSlack() {
    if (slackHookOk) {
      return sendSlackWebhook(slackHookUrl);
    }
    if (slackBotOk) {
      return sendSlackBot(slackBotToken, slackChannel);
    }
    if (slackHookUrl && !slackHookOk) {
      return {
        ok: false,
        detail:
          "SLACK_WEBHOOK_URL must be https://hooks.slack.com/... If you have a bot token (xoxb-...), use env vars SLACK_BOT_TOKEN and SLACK_CHANNEL instead."
      };
    }
    if (slackBotToken && !slackChannel) {
      return {
        ok: false,
        detail:
          "SLACK_BOT_TOKEN is set but SLACK_CHANNEL is missing. Add SLACK_CHANNEL with your channel ID (e.g. C01234ABCDE from channel details in Slack)."
      };
    }
    return { ok: false, detail: "Slack not configured" };
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
    if (formspreeOk) {
      const fsRes = await sendFormspree();
      if (!fsRes.ok) {
        return res.status(502).json({
          ok: false,
          error: "formspree_rejected",
          detail: fsRes.detail || "unknown"
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (slackReady) {
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
