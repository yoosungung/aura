// aura.tasks.smoke MQT echo (ARCHITECTURE §4.1 / SETUP naming).
// Success HTTP 2xx body -> MessageQueueTrigger respTopic (aura.events.tasks.smoke.done).
// Non-2xx -> retries then errorTopic (aura.events.tasks.smoke.error).
module.exports = async function (context) {
  const req = (context && context.request) || {};
  let raw = req.body;
  if (raw == null) raw = "";
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  if (typeof raw !== "string") raw = JSON.stringify(raw);

  let parsed;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({
        error: "invalid_json",
        detail: String(err && err.message ? err.message : err),
      }),
    };
  }

  if (parsed && parsed.aura_smoke === "fail") {
    return {
      status: 500,
      body: JSON.stringify({
        error: "aura_smoke_fail",
        id: parsed.id || null,
      }),
    };
  }

  const out = {
    id: parsed.id || null,
    type: "tasks.smoke.done",
    echo: parsed,
  };
  return { status: 200, body: JSON.stringify(out) };
};
