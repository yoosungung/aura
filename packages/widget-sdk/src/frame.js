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
  let boundIdentifier = "";
  let pendingUser = null;
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
      bindUser();
    }
    if (msg.event === "setUser" && msg.payload.identifier_hash && msg.payload.identifier) {
      pendingUser = {
        identifier: msg.payload.identifier,
        identifier_hash: msg.payload.identifier_hash,
        name: msg.payload.name || "",
        email: msg.payload.email || "",
      };
      bindUser();
    }
  });

  async function bindUser() {
    if (!pendingUser || !token || !inboxId) {
      return;
    }
    const res = await fetchImpl(`${apiBase}/public/api/v1/inboxes/${inboxId}/identify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pendingUser),
    });
    if (!res.ok) {
      return;
    }
    boundIdentifier = pendingUser.identifier;
    pendingUser = null;
  }

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
      if (payload.message?.payload?.private) {
        return;
      }
      const msg = payload.message?.payload || {};
      if (msg.content_type === "input_csat") {
        appendCSAT(msg.content, payload.conversation_id);
        return;
      }
      const content = msg.content;
      if (content) append(content, msg.sender_type);
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

  function appendCSAT(content) {
    const list = win.document.getElementById("messages");
    if (!list || typeof list.appendChild !== "function" || !win.document.createElement) {
      return;
    }
    const item = win.document.createElement("li");
    item.dataset.csat = "true";
    item.appendChild(win.document.createTextNode(content || ""));
    for (let n = 1; n <= 5; n += 1) {
      const btn = win.document.createElement("button");
      btn.type = "button";
      btn.textContent = String(n);
      btn.addEventListener("click", () => {
        rate(n);
      });
      item.appendChild(btn);
    }
    list.appendChild(item);
  }

  async function rate(rating) {
    if (!token || !inboxId) {
      return;
    }
    await fetchImpl(`${apiBase}/public/api/v1/inboxes/${inboxId}/csat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rating }),
    });
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
    await bindUser();
    return body;
  }

  return {
    send,
    token: () => token,
    identifier: () => boundIdentifier,
  };
}
