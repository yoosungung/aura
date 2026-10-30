import { isAllowedOrigin, parseHelpdeskOrigin, widgetSrc } from "./origin.js";
import { decode, encode } from "./protocol.js";

const FRAME_ID = "aura-widget-frame";
const HOST_ID = "aura-widget-host";

export function createLoader(win, opts) {
  const helpdesk = parseHelpdeskOrigin(opts.baseUrl);
  if (win.$aura) {
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

  const postToFrame = (event, payload) => {
    iframe.contentWindow?.postMessage(encode(event, payload), helpdesk);
  };

  let frameMounted = false;
  function setFrameMounted(on) {
    if (on && !frameMounted) {
      win.document.body.appendChild(iframe);
      frameMounted = true;
    } else if (!on && frameMounted) {
      if (typeof iframe.remove === "function") {
        iframe.remove();
      } else if (iframe.parentNode?.removeChild) {
        iframe.parentNode.removeChild(iframe);
      } else {
        const kids = win.document.body.children;
        const i = Array.prototype.indexOf.call(kids, iframe);
        if (i >= 0 && kids.splice) {
          kids.splice(i, 1);
        }
      }
      frameMounted = false;
    }
  }

  function applyOpen(open, silent) {
    api.open = open;
    if (open) {
      const mobile = (win.innerWidth || 1280) < 480;
      setFrameMounted(true);
      iframe.style.display = "";
      iframe.style.pointerEvents = "auto";
      if (mobile) {
        iframe.style.inset = "0";
        iframe.style.right = "0";
        iframe.style.bottom = "0";
        iframe.style.width = "100vw";
        iframe.style.height = "100dvh";
        iframe.style.borderRadius = "0";
      } else {
        iframe.style.inset = "";
        iframe.style.right = "20px";
        iframe.style.bottom = "88px";
        iframe.style.width = "380px";
        iframe.style.height = "min(640px, calc(100dvh - 40px))";
        iframe.style.borderRadius = "16px";
      }
      launcher.style.display = "none";
    } else {
      iframe.style.display = "none";
      iframe.style.pointerEvents = "none";
      iframe.style.inset = "";
      iframe.style.width = "0px";
      iframe.style.height = "0px";
      setFrameMounted(false);
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
