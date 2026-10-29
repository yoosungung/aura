import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { liveClient } from "./gateway.js";
import { fixtureState, parseSession } from "./store.js";
import "./styles.css";

const session = parseSession(window.location.search, import.meta.env);
createRoot(document.getElementById("root")).render(
  <App
    session={session}
    client={liveClient}
    initialState={session.fixture ? fixtureState() : undefined}
  />,
);
