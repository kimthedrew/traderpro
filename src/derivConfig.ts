// Shared Deriv API constants -- split out from app.ts so realTradingRoutes.ts
// (and derivAuthClient.ts) can use them without importing back into the
// module that mounts them, which would create a circular import.

// DERIV_APP_ID is really an OAuth2 client_id (Deriv's dashboard just calls
// it "App ID"). Registered per-app at https://developers.deriv.com.
export const APP_ID = process.env.DERIV_APP_ID ?? "";
export const DERIV_API_BASE = "https://api.derivws.com";
