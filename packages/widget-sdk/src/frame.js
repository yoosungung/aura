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

  let seed = "";
  let token = "";
  let inboxId = "";
  let boundIdentifier = "";
  let pendingUser = null;
  let socket;
  let lastWsToken = "";
  let exchanging;
  let unread = 0;

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
      seed = msg.payload.token ?? "";
      inboxId = msg.payload.inboxId ?? "";
      exchanging = null;
      token = "";
      ensureAuth()
        .then(() => bindUser())
        .catch(() => {});
    }
    if (msg.event === "setUser" && msg.payload.identifier_hash && msg.payload.identifier) {
      pendingUser = {
        identifier: msg.payload.identifier,
        identifier_hash: msg.payload.identifier_hash,
        name: msg.payload.name || "",
        email: msg.payload.email || "",
      };
      ensureAuth()
        .then(() => bindUser())
        .catch(() => {});
    }
    if (msg.event === "toggle" && msg.payload?.open === false) {
      win.parent.postMessage(encode("close"), parentOrigin);
    }
  });

  async function ensureAuth() {
    if (token) {
      return token;
    }
    if (!seed || !inboxId) {
      throw new Error("not initialized");
    }
    if (!exchanging) {
      exchanging = (async () => {
        const res = await fetchImpl(`${apiBase}/public/api/v1/inboxes/${inboxId}/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pubsub_token: seed }),
        });
        if (!res.ok) {
          exchanging = null;
          throw new Error("auth failed");
        }
        const body = await res.json();
        token = body.access_token || body.token || "";
        connectWS();
        return token;
      })().catch((err) => {
        exchanging = null;
        throw err;
      });
    }
    return exchanging;
  }

  function authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function apiFetch(path, init, retried = false) {
    await ensureAuth();
    const res = await fetchImpl(`${apiBase}${path}`, {
      ...init,
      headers: authHeaders(init.headers),
    });
    if (res.status === 401 && !retried) {
      token = "";
      exchanging = null;
      return apiFetch(path, init, true);
    }
    return res;
  }

  async function bindUser() {
    if (!pendingUser || !inboxId) {
      return;
    }
    const res = await apiFetch(`/public/api/v1/inboxes/${inboxId}/identify`, {
      method: "POST",
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
    const connecting = 0;
    const open = 1;
    if (
      socket &&
      lastWsToken === token &&
      (socket.readyState === connecting || socket.readyState === open || socket.readyState == null)
    ) {
      return;
    }
    socket?.close?.();
    const wsBase = apiBase.replace(/^http/, "ws");
    socket = new WebSocketImpl(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    lastWsToken = token;
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
        appendCSAT(msg.content);
        return;
      }
      const content = msg.content;
      if (content) {
        append(content, msg.sender_type);
        if (msg.sender_type === "User") {
          unread += 1;
          win.parent.postMessage(encode("unread", { count: unread }), parentOrigin);
        }
      }
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
    item.dataset.sender = senderType ?? "";
    if (win.document.createElement) {
      const who = win.document.createElement("span");
      who.className = "who";
      who.textContent = senderType === "Contact" ? "고객" : "상담원";
      const body = win.document.createElement("p");
      body.textContent = content;
      item.appendChild(who);
      item.appendChild(body);
    } else {
      item.textContent = content;
    }
    list.appendChild(item);
  }

  function appendCSAT(content) {
    const list = win.document.getElementById("messages");
    if (!list || typeof list.appendChild !== "function" || !win.document.createElement) {
      return;
    }
    const item = win.document.createElement("li");
    item.dataset.csat = "true";
    item.className = "csat";
    item.setAttribute("aria-label", "상담 만족도를 평가해 주세요");
    const title = win.document.createElement("p");
    title.textContent = `⭐ ${content || "상담 만족도를 평가해 주세요"}`;
    item.appendChild(title);
    const row = win.document.createElement("div");
    for (let n = 1; n <= 5; n += 1) {
      const btn = win.document.createElement("button");
      btn.type = "button";
      btn.textContent = String(n);
      btn.setAttribute("aria-label", `${n}점`);
      btn.addEventListener("click", () => rate(n));
      row.appendChild(btn);
    }
    item.appendChild(row);
    list.appendChild(item);
  }

  async function rate(rating) {
    if (!inboxId) {
      return;
    }
    await apiFetch(`/public/api/v1/inboxes/${inboxId}/csat`, {
      method: "POST",
      body: JSON.stringify({ rating }),
    });
  }

  async function send(content) {
    if (!inboxId && !seed) {
      throw new Error("not initialized");
    }
    const res = await apiFetch(`/public/api/v1/inboxes/${inboxId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error("send failed");
    }
    const body = await res.json();
    if (body.access_token || body.token) {
      token = body.access_token || body.token;
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
