import "@fontsource-variable/instrument-sans";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { AuthPage } from "./auth-page.js";
import "./styles.css";

const root = document.querySelector("#root");

if (!(root instanceof HTMLElement)) {
  throw new Error("Root element #root was not found.");
}

createRoot(root).render(
  <StrictMode>
    {location.pathname === "/signin" || location.pathname === "/signout" ? (
      <AuthPage mode={location.pathname === "/signin" ? "signin" : "signout"} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
