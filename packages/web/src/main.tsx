import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { SessionProvider } from "./state/session";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("找不到挂载节点 #root");
}

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
