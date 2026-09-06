import {
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SUPABASE_URL,
} from "./auth.ts";

function scriptValue(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function oauthConsentResponse(): Response {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL;
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize NeuralSynch</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07100f; color: #e8f5f1; }
    main { width: min(92vw, 34rem); padding: 2rem; border: 1px solid #23534a; border-radius: 1rem; background: #0d1b19; box-shadow: 0 1.5rem 4rem #0008; }
    h1 { margin: 0 0 .5rem; font-size: 1.55rem; }
    p { color: #b8cdc8; line-height: 1.5; }
    label { display: grid; gap: .4rem; margin: .8rem 0; color: #d8e9e5; }
    input { box-sizing: border-box; width: 100%; padding: .78rem; border: 1px solid #38675f; border-radius: .55rem; background: #07100f; color: #fff; }
    button { padding: .78rem 1rem; border: 0; border-radius: .55rem; font-weight: 700; cursor: pointer; }
    button.primary { background: #58d5b5; color: #06201a; }
    button.secondary { background: #243c37; color: #e8f5f1; }
    button:disabled { opacity: .55; cursor: wait; }
    .actions { display: flex; gap: .7rem; margin-top: 1.2rem; }
    .hidden { display: none; }
    .details { padding: .9rem; border-radius: .6rem; background: #07100f; }
    .error { color: #ffb9b9; white-space: pre-wrap; }
    .muted { font-size: .88rem; color: #8eaaa3; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize NeuralSynch</h1>
    <p id="status">Checking this authorization request…</p>
    <form id="login" class="hidden">
      <p>Sign in to the staging NeuralSynch tenant that should authorize this client.</p>
      <label>Email<input id="email" type="email" autocomplete="username" required></label>
      <label>Password<input id="password" type="password" autocomplete="current-password" required></label>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <section id="consent" class="hidden">
      <div class="details">
        <strong id="client-name">MCP client</strong>
        <p id="client-detail"></p>
        <p id="scope-detail" class="muted"></p>
      </div>
      <div class="actions">
        <button id="approve" class="primary" type="button">Approve</button>
        <button id="deny" class="secondary" type="button">Deny</button>
      </div>
    </section>
    <p id="error" class="error"></p>
  </main>
  <script type="module" nonce="${nonce}">
    import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

    const supabase = createClient(${scriptValue(supabaseUrl)}, ${
    scriptValue(publishableKey)
  }, {
      auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true }
    });
    const authorizationId = new URL(location.href).searchParams.get("authorization_id");
    const status = document.querySelector("#status");
    const errorBox = document.querySelector("#error");
    const login = document.querySelector("#login");
    const consent = document.querySelector("#consent");
    const approve = document.querySelector("#approve");
    const deny = document.querySelector("#deny");

    function showError(error) {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    }

    function setBusy(value) {
      approve.disabled = value;
      deny.disabled = value;
    }

    async function loadAuthorization() {
      errorBox.textContent = "";
      if (!authorizationId) throw new Error("Missing authorization_id.");
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!sessionData.session) {
        status.textContent = "Authentication is required before access can be approved.";
        login.classList.remove("hidden");
        consent.classList.add("hidden");
        return;
      }

      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (error) throw error;
      if (!("authorization_id" in data)) {
        location.assign(data.redirect_url);
        return;
      }

      const client = data.client ?? data.oauth_client ?? {};
      const scopes = data.scopes ?? data.scope ?? [];
      document.querySelector("#client-name").textContent = client.name ?? client.client_name ?? "MCP client";
      document.querySelector("#client-detail").textContent =
        "This client is requesting access to the NeuralSynch tenants bound to your authenticated identity.";
      document.querySelector("#scope-detail").textContent = Array.isArray(scopes) && scopes.length
        ? "Requested scopes: " + scopes.join(", ")
        : "Requested access is constrained by NeuralSynch tenant membership and row-level security.";
      status.textContent = "Review and approve this request only if you initiated it.";
      login.classList.add("hidden");
      consent.classList.remove("hidden");
    }

    login.addEventListener("submit", async (event) => {
      event.preventDefault();
      errorBox.textContent = "";
      const button = login.querySelector("button");
      button.disabled = true;
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email: document.querySelector("#email").value,
          password: document.querySelector("#password").value,
        });
        if (error) throw error;
        await loadAuthorization();
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    });

    approve.addEventListener("click", async () => {
      setBusy(true);
      try {
        const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId);
        if (error) throw error;
        location.assign(data.redirect_url);
      } catch (error) {
        showError(error);
        setBusy(false);
      }
    });

    deny.addEventListener("click", async () => {
      setBusy(true);
      try {
        const { data, error } = await supabase.auth.oauth.denyAuthorization(authorizationId);
        if (error) throw error;
        location.assign(data.redirect_url);
      } catch (error) {
        showError(error);
        setBusy(false);
      }
    });

    loadAuthorization().catch(showError);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        `default-src 'none'; script-src 'nonce-${nonce}' https://esm.sh; connect-src ${supabaseUrl}; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
