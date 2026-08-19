// Deriv's OAuth2 callback lands here with either ?code=...&state=... on
// success, or ?error=...&error_description=... if the user declined/it
// failed. code_verifier and the original state were stashed in
// sessionStorage (by app.js) right before the redirect to Deriv.
const params = new URLSearchParams(window.location.search);
const code = params.get("code");
const returnedState = params.get("state");
const oauthError = params.get("error");

async function connect() {
  const storedState = sessionStorage.getItem("oauth_state");
  const codeVerifier = sessionStorage.getItem("pkce_code_verifier");
  sessionStorage.removeItem("oauth_state");
  sessionStorage.removeItem("pkce_code_verifier");

  if (oauthError) {
    window.location.replace(`/?login_error=${encodeURIComponent(oauthError)}`);
    return;
  }
  if (!code) {
    window.location.replace("/");
    return;
  }

  if (!returnedState || returnedState !== storedState) {
    // Mismatch could mean a CSRF attempt -- don't exchange the code.
    window.location.replace("/?login_error=state_mismatch");
    return;
  }

  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.location.replace(`/?login_error=${encodeURIComponent(body.stage ?? "session_exchange")}`);
      return;
    }
  } catch {
    window.location.replace("/?login_error=network");
    return;
  }
  window.location.replace("/");
}

connect();
