import { isAllowedOrigin, parseHelpdeskOrigin, widgetSrc } from "./origin.js";
import { decode, encode } from "./protocol.js";

const FRAME_ID = "aura-widget-frame";
const HOST_ID = "aura-widget-host";

export function createLoader(win, opts) {
  const helpdesk = parseHelpdeskOrigin(opts.baseUrl);
  const existing = win.document.getElementById(FRAME_ID);
  if (existing && win.$aura) {
    return win.$aura;
  }

  const host = win.document.createElement("div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.right = "20px";
  host.style.bottom = "20px";
  host.style.zIndex = "2147483000";
  const shadow = typeof host.attachShadow === "function" ? host.attachShadow({ mode: "open" }) : host;
  const launcher = win.document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute?.("aria-label", "채팅 열기");
  launcher.textContent = "💬";
  launcher.style.width = "60px";
  launcher.style.height = "60px";
  launcher.style.borderRadius = "9999px";
  launcher.style.border = "0";
  launcher.style.cursor = "pointer";
  shadow.appendChild(launcher);
  win.document.body.appendChild(host);

  const iframe = win.document.createElement("iframe");
  iframe.id = FRAME_ID;
  iframe.title = "Aura";
  iframe.src = widgetSrc(opts.baseUrl, win.location.origin);
  iframe.style.border = "0";
  iframe.style.position = "fixed";
  iframe.style.right = "20px";
  iframe.style.bottom = "88px";
  iframe.style.zIndex = "2147483000";
  win.document.body.appendChild(iframe);

  const postToFrame = (event, payload) => {
    iframe.contentWindow.postMessage(encode(event, payload), helpdesk);
  };

  function applyOpen(open, silent) {
    api.open = open;
    if (open) {
      iframe.style.display = "";
      iframe.style.pointerEvents = "auto";
      iframe.style.width = "380px";
      iframe.style.height = "640px";
      iframe.style.borderRadius = "16px";
      launcher.style.display = "none";
    } else {
      iframe.style.display = "none";
      iframe.style.pointerEvents = "none";
      iframe.style.width = "0px";
      iframe.style.height = "0px";
      launcher.style.display = "";
    }
    if (!silent) {
      postToFrame("toggle", { open });
    }
  }

  const api = {
    iframe,
    open: false,
    toggle() {
      applyOpen(!api.open);
    },
    setUser(identifier, attrs = {}) {
      postToFrame("setUser", { identifier, ...attrs });
    },
  };

  applyOpen(false, true);
  launcher.addEventListener?.("click", () => applyOpen(true));

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
      applyOpen(false);
    }
    if (msg.event === "resize" && msg.payload) {
      if (msg.payload.height) iframe.style.height = `${msg.payload.height}px`;
      if (msg.payload.width) iframe.style.width = `${msg.payload.width}px`;
    }
    if (msg.event === "unread" && launcher) {
      const n = Number(msg.payload?.count) || 0;
      launcher.textContent = n > 0 ? `💬 ${n}` : "💬";
    }
  });

  win.$aura = api;
  return api;
}
