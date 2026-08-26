import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./store/coauthStore"; // side-effect: exposes window.__coauth
import { registerToolsWithRetry } from "./mcp/registerTools";
import "./theme.css";

registerToolsWithRetry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
