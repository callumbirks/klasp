import { KlaspProvider } from "@klasp/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { chatContract as api } from "../shared/chat.js";
import "./styles.css";

const klaspEndpoint = import.meta.env.DEV
    ? "http://localhost:8787/klasp"
    : "/klasp";
const root = document.getElementById("root");

if (!root) {
    throw new Error("Root element was not found.");
}

createRoot(root).render(
    <StrictMode>
        <KlaspProvider api={api} endpoint={klaspEndpoint}>
            <App />
        </KlaspProvider>
    </StrictMode>,
);
