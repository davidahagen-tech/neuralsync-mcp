import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from "./auth.ts";

function scriptValue(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function passwordRecoveryResponse(): Response {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ??
    DEFAULT_SUPABASE_ANON_KEY;
  const recoveryEmail = "davidahagen@proton.me";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Set NeuralSynch staging password</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07100f; color: #e8f5f1; }
    main { width: min(92vw, 34rem); padding: 2rem; border: 1px solid #23534a; border-radius: 1rem; background: #0d1b19; box-shadow: 0 1.5rem 4rem #0008; }
    h1 { margin: 0 0 .5rem; font-size: 1.55rem; }
    p { color: #b8cdc8; line-height: 1.5; }
    label { display: grid; gap: .4rem; margin: .8rem 0; color: #d8e9e5; }
    input { box-sizing: border-box; width: 100%; padding: .78rem; border: 1px solid #38675f; border-radius: .55rem; background: #07100f; color: #fff; }
    button { padding: .78rem 1rem; border: 0; border-radius: .55rem; font-weight: 700; cursor: pointer; background: #58d5b5; color: #06201a; }
    button:disabled { opacity: .55; cursor: wait; }
    .hidden { display: none; }
    .error { color: #ffb9b9; white-space: pre-wrap; }
    .success { color: #8ff0d4; white-space: pre-wrap; }
    .muted { font-size: .88rem; color: #8eaaa3; }
  </style>
</head>
<body>
  <main>
    <h1>Set NeuralSynch staging password</h1>
    <p id="status">Request a one-time recovery link for the designated <code>p0-alpha</code> staging identity.</p>
    <form id="request-form">
      <label>Email<input id="email" type="email" autocomplete="username" required></label>
      <button type="submit">Send recovery email</button>
      <p class="muted">This temporary staging page accepts only the designated Alpha address.</p>
    </form>
    <form id="password-form" class="hidden">
      <label>New password<input id="password" type="password" autocomplete="new-password" minlength="12" required></label>
      <label>Confirm new password<input id="password-confirm" type="password" autocomplete="new-password" minlength="12" required></label>
      <button type="submit">Set password</button>
    </form>
    <p id="message"></p>
  </main>
  <script type="module" nonce="${nonce}">
    import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

    const supabase = createClient(${scriptValue(supabaseUrl)}, ${
    scriptValue(anonKey)
  }, {
      auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true, flowType: "pkce" }
    });
    const designatedEmail = ${scriptValue(recoveryEmail)};
    const resetUrl = location.origin + "/auth/reset-password";
    const requestForm = document.querySelector("#request-form");
    const passwordForm = document.querySelector("#password-form");
    const status = document.querySelector("#status");
    const message = document.querySelector("#message");
    const email = document.querySelector("#email");
    email.value = designatedEmail;

    function showMessage(text, kind = "error") {
      message.className = kind;
      message.textContent = text;
    }

    function showPasswordForm() {
      requestForm.classList.add("hidden");
      passwordForm.classList.remove("hidden");
      status.textContent = "Recovery verified. Choose a new staging password.";
      showMessage("", "success");
    }

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (session && location.hash)) {
        showPasswordForm();
      }
    });

    const { data: initial } = await supabase.auth.getSession();
    if (initial.session && (location.hash || location.search.includes("code="))) {
      showPasswordForm();
    }

    requestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      showMessage("");
      const normalized = email.value.trim().toLowerCase();
      if (normalized !== designatedEmail) {
        showMessage("Use the designated p0-alpha staging email address.");
        return;
      }
      const button = requestForm.querySelector("button");
      button.disabled = true;
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(normalized, { redirectTo: resetUrl });
        if (error) throw error;
        showMessage("Recovery email sent. Open the newest Supabase password-reset email in this Chrome profile.", "success");
      } catch (error) {
        showMessage(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
      }
    });

    passwordForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      showMessage("");
      const password = document.querySelector("#password").value;
      const confirmation = document.querySelector("#password-confirm").value;
      if (password !== confirmation) {
        showMessage("The passwords do not match.");
        return;
      }
      const button = passwordForm.querySelector("button");
      button.disabled = true;
      try {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        await supabase.auth.signOut({ scope: "local" });
        passwordForm.reset();
        passwordForm.classList.add("hidden");
        status.textContent = "Password set successfully.";
        showMessage("Return to the Claude connector authorization and sign in with the new password.", "success");
      } catch (error) {
        showMessage(error instanceof Error ? error.message : String(error));
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        `default-src 'none'; script-src 'nonce-${nonce}' https://esm.sh; connect-src ${supabaseUrl}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
