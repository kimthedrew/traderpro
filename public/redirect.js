// Deriv's OAuth2 callback lands here with either ?code=...&state=... on
// success, or ?error=...&error_description=... if the user declined/it
// failed. code_verifier and the original state were stashed in
// sessionStorage (by app.js) right before the redirect to Deriv.
const params = new URLSearchParams(window.location.search);
const code = params.get("code");
const returnedState = params.get("state");
const oauthError = params.get("error");

const statusEl = document.getElementById("status");

async function connect() {
  const storedState = sessionStorage.getItem("oauth_state");
  const codeVerifier = sessionStorage.getItem("pkce_code_verifier");
  sessionStorage.removeItem("oauth_state");
  sessionStorage.removeItem("pkce_code_verifier");

  if (oauthError || !code) {
    window.location.replace("/");
    return;
  }

  if (!returnedState || returnedState !== storedState) {
    // Mismatch could mean a CSRF attempt -- don't exchange the code.
    statusEl.textContent = "Login could not be verified. Redirecting you back...";
    setTimeout(() => window.location.replace("/"), 1500);
    return;
  }

  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });
    if (!res.ok) throw new Error("Session exchange failed");
  } catch {
    statusEl.textContent = "Couldn't connect your Deriv account. Redirecting you back...";
  } finally {
    window.location.replace("/");
  }
}

connect();
