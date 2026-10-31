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
  let open = false;
  let conversationId = "";
  let typingTimer;

  const apiBase = win.location.origin;

  win.parent.postMessage(encode("ready"), parentOrigin);

  win.addEventListener("message", (event) => {
    if (!isAllowedOrigin(event.origin, parentOrigin) || event.source !== win.parent) {
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
    if (msg.event === "toggle") {
      open = msg.payload?.open === true;
      if (open) {
        unread = 0;
      } else {
        win.parent.postMessage(encode("close"), parentOrigin);
      }
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
    const opened = 1;
    if (
      socket &&
      lastWsToken === token &&
      (socket.readyState === connecting || socket.readyState === opened || socket.readyState == null)
    ) {
      return;
    }
    if (socket) {
      socket.onclose = null;
      socket.close?.();
    }
    const wsBase = apiBase.replace(/^http/, "ws");
    const live = new WebSocketImpl(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    socket = live;
    lastWsToken = token;
    live.onclose = () => {
      if (socket !== live) {
        return;
      }
      lastWsToken = "";
      token = "";
      exchanging = null;
      socket = null;
      ensureAuth().catch(() => {});
    };
    live.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type !== "event") {
        return;
      }
      if (payload.event === "typing") {
        if (payload.user_type === "Contact") {
          return;
        }
        showTyping(payload.is_typing === true);
        return;
      }
      if (payload.event !== "message.created") {
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
      if (content && msg.sender_type !== "Contact") {
        append(content, msg.sender_type);
        if (msg.sender_type === "User" && !open) {
          unread += 1;
          win.parent.postMessage(encode("unread", { count: unread }), parentOrigin);
        }
      }
    };
  }

  function showTyping(on) {
    const list = win.document.getElementById("messages");
    if (!list) {
      return;
    }
    const existing = list.querySelector?.("[data-typing='true']") || list.querySelector?.("[data-typing]");
    if (!on) {
      existing?.remove?.();
      if (existing && list.removeChild && !existing.remove) {
        list.removeChild(existing);
      }
      return;
    }
    if (existing) {
      return;
    }
    const item = win.document.createElement ? win.document.createElement("li") : { textContent: "", dataset: {} };
    item.dataset.typing = "true";
    item.textContent = "입력 중";
    if (typeof list.appendChild === "function") {
      list.appendChild(item);
    }
  }

  function sendTyping(isTyping) {
    if (!socket || typeof socket.send !== "function") {
      return;
    }
    if (socket.readyState != null && socket.readyState !== 1) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "typing",
        conversation_id: conversationId,
        inbox_id: inboxId,
        is_typing: isTyping,
      }),
    );
  }

  function watchComposer(input) {
    if (!input || typeof input.addEventListener !== "function") {
      return;
    }
    input.addEventListener("input", () => {
      sendTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => sendTyping(false), 400);
    });
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

  async function searchHelp(query) {
    if (!inboxId) {
      return [];
    }
    const res = await fetchImpl(
      `${apiBase}/public/api/v1/inboxes/${inboxId}/articles?q=${encodeURIComponent(query || "")}`,
    );
    if (!res.ok) {
      return [];
    }
    const body = await res.json();
    const articles = body.articles || [];
    const list = win.document.getElementById("help-results");
    if (list && typeof list.replaceChildren === "function" && win.document.createElement) {
      list.replaceChildren();
      for (const article of articles) {
        const item = win.document.createElement("li");
        const title = win.document.createElement("strong");
        title.textContent = article.title || "";
        const excerpt = win.document.createElement("p");
        excerpt.textContent = article.body || "";
        item.appendChild(title);
        item.appendChild(excerpt);
        list.appendChild(item);
      }
    }
    return articles;
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
    if (body.conversation_id) {
      conversationId = body.conversation_id;
    }
    append(content, "Contact");
    connectWS();
    await bindUser();
    return body;
  }

  watchComposer(
    win.document.getElementById("composer")?.elements?.namedItem("content") ||
      win.document.querySelector?.("#composer input"),
  );

  return {
    send,
    searchHelp,
    watchComposer,
    token: () => token,
    identifier: () => boundIdentifier,
  };
}
