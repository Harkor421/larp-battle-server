// Backend origin for the API + WebSocket. Empty string = same origin (local dev,
// or when the Node server also serves these static files).
// On Vercel this is overwritten at deploy time with the Railway backend URL.
window.LARP_CONFIG = { backendOrigin: "" };
