import { isAllowedOrigin, parseHelpdeskOrigin } from "./origin.js";
import { decode, encode } from "./protocol.js";

export function createFrame(win, deps = {}) {
  const fetchImpl = deps.fetch ?? win.fetch.bind(win);
  const WebSocketImpl = deps.WebSocket ?? win.WebSocket;
  let parentOrigin = "";
  try {
    parentOrigin = parseHelpdeskOrigin(
      new URLSearchParams(win.location.search).get("parent_origin") ?? "",
    );
  } catch {
    return {
      send: async () => {
        throw new Error("no parent");
      },
      token: () => "",
      identifier: () => "",
    };
  }

  let token = "";
  let inboxId = "";
  let socket;

  const apiBase = win.location.origin;

  win.parent.postMessage(encode("ready"), parentOrigin);

  win.addEventListener("message", (event) => {
    if (!isAllowedOrigin(event.origin, parentOrigin)) {
      return;
    }
    const msg = decode(event.data);
    if (!msg) {
      return;
    }
    if (msg.event === "init") {
      token = msg.payload.token ?? "";
      inboxId = msg.payload.inboxId ?? "";
    }
    if (msg.event === "setUser" && msg.payload.identifier_hash) {
      // P3: HMAC bind. P2 stores nothing without a server round-trip.
    }
  });

  function connectWS() {
    if (!token || !WebSocketImpl) {
      return;
    }
    const wsBase = apiBase.replace(/^http/, "ws");
    socket = new WebSocketImpl(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type !== "event" || payload.event !== "message.created") {
        return;
      }
      const content = payload.message?.payload?.content;
      if (content) append(content, payload.message?.payload?.sender_type);
    };
  }

  function append(content, senderType) {
    const list = win.document.getElementById("messages");
    if (!list || typeof list.appendChild !== "function") {
      return;
    }
    const item = win.document.createElement
      ? win.document.createElement("li")
      : { textContent: "" };
    item.textContent = content;
    item.dataset.sender = senderType ?? "";
    list.appendChild(item);
  }

  async function send(content) {
    if (!token || !inboxId) {
      throw new Error("not initialized");
    }
    const res = await fetchImpl(`${apiBase}/public/api/v1/inboxes/${inboxId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error("send failed");
    }
    const body = await res.json();
    if (body.token) {
      token = body.token;
    }
    append(content, "Contact");
    connectWS();
    return body;
  }

  return {
    send,
    token: () => token,
    identifier: () => "",
  };
}
