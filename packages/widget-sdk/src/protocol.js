export const SOURCE = "aura-widget";

export function encode(event, payload = {}) {
  return { source: SOURCE, event, payload };
}

export function decode(data) {
  if (!data || data.source !== SOURCE || typeof data.event !== "string") {
    return null;
  }
  return { event: data.event, payload: data.payload ?? {} };
}
