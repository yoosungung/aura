import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { liveClient } from "./gateway.js";
import { fixtureState, parseSession, type SessionEnv } from "./store.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("root missing");
}

const session = parseSession(window.location.search, import.meta.env as SessionEnv);
createRoot(root).render(
  <App
    session={session}
    client={liveClient}
    initialState={session.fixture ? fixtureState() : undefined}
  />,
);
