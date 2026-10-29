export function parseHelpdeskOrigin(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("invalid baseUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid baseUrl");
  }
  return parsed.origin;
}

export function isAllowedOrigin(eventOrigin, allowedOrigin) {
  return Boolean(eventOrigin) && eventOrigin === allowedOrigin;
}

export function widgetSrc(baseUrl, parentOrigin) {
  const origin = parseHelpdeskOrigin(baseUrl);
  const parent = parseHelpdeskOrigin(parentOrigin);
  const url = new URL("/widget.html", origin);
  url.searchParams.set("parent_origin", parent);
  return url.toString();
}
