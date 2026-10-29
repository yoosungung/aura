import { isAllowedOrigin, parseHelpdeskOrigin, widgetSrc } from "./origin.js";
import { decode, encode } from "./protocol.js";

const FRAME_ID = "aura-widget-frame";

export function createLoader(win, opts) {
  const helpdesk = parseHelpdeskOrigin(opts.baseUrl);
  const existing = win.document.getElementById(FRAME_ID);
  if (existing && win.$aura) {
    return win.$aura;
  }

  const iframe = win.document.createElement("iframe");
  iframe.id = FRAME_ID;
  iframe.title = "Aura";
  iframe.src = widgetSrc(opts.baseUrl, win.location.origin);
  iframe.style.border = "0";
  win.document.body.appendChild(iframe);

  const postToFrame = (event, payload) => {
    iframe.contentWindow.postMessage(encode(event, payload), helpdesk);
  };

  const api = {
    iframe,
    open: true,
    toggle() {
      api.open = !api.open;
      iframe.style.display = api.open ? "" : "none";
      postToFrame("toggle", { open: api.open });
    },
    setUser(identifier, attrs = {}) {
      postToFrame("setUser", { identifier, ...attrs });
    },
  };

  win.addEventListener("message", (event) => {
    if (!isAllowedOrigin(event.origin, helpdesk)) {
      return;
    }
    const msg = decode(event.data);
    if (!msg) {
      return;
    }
    if (msg.event === "ready") {
      postToFrame("init", { token: opts.token, inboxId: opts.inboxId });
    }
    if (msg.event === "close") {
      api.open = false;
      iframe.style.display = "none";
    }
    if (msg.event === "resize" && msg.payload) {
      if (msg.payload.height) iframe.style.height = `${msg.payload.height}px`;
      if (msg.payload.width) iframe.style.width = `${msg.payload.width}px`;
    }
  });

  win.$aura = api;
  return api;
}
