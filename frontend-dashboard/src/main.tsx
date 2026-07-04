import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App.tsx";
import "./index.css";

// Optional: "Sign in with Google" is simply absent from AuthScreen if this
// isn't set, rather than the app crashing or rendering a broken button --
// same "gracefully degrades when unconfigured" pattern as this project's
// other optional integrations (e.g. ANTHROPIC_API_KEY on the backend).
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

createRoot(document.getElementById("root")!).render(
  GOOGLE_CLIENT_ID ? <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>{app}</GoogleOAuthProvider> : app,
);
