import { KlaspProvider } from "@klasp/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { api } from "./klasp.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
    throw new Error("Root element was not found.");
}

createRoot(root).render(
    <StrictMode>
        <KlaspProvider api={api} endpoint="/klasp">
            <App />
        </KlaspProvider>
    </StrictMode>,
);
