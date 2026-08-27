import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./store/coauthStore"; // side-effect: dev-only inspection handle
import { registerToolsWithRetry } from "./mcp/registerTools";
import "./theme.css";

registerToolsWithRetry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
