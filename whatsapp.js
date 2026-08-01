// WhatsApp chat-export parser (v1). Turns raw exported .txt into structured
// {seq, ts, sender, body, is_system} rows. Deliberately dumb/regex-based --
// no AI here, this is the reliable-timeline layer that must still work when
// llm.js is unconfigured. AI extraction on top of this lives in llm.js.

// Android: "12/03/24, 6:45 PM - Alice: message" (also handles 24h "18:45")
const LINE_RE_ANDROID = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s?[APap][Mm])?)\s-\s([^:]{1,60}?):\s(.*)$/;
// iOS: "[12/03/24, 6:45:30 PM] Alice: message"
const LINE_RE_IOS = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]\s([^:]{1,60}?):\s(.*)$/;

const SYSTEM_PATTERNS = [
  /messages and calls are end-to-end encrypted/i,
  /<media omitted>/i,
  /image omitted/i,
  /video omitted/i,
  /audio omitted/i,
  /sticker omitted/i,
  /document omitted/i,
  /gif omitted/i,
  /this message was deleted/i,
  /you deleted this message/i,
  /missed voice call/i,
  /missed video call/i,
  /changed the subject/i,
  /changed this group's icon/i,
  /created group/i,
  /added you/i,
  /you were added/i,
  /left$/i,
  /changed their phone number/i,
  /security code changed/i
];

function isSystemLine(body) {
  return SYSTEM_PATTERNS.some(re => re.test(body));
}

function parseWhatsAppExport(text) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const messages = [];
  let current = null;
  let seq = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/‎/g, '').trimEnd(); // strip WhatsApp's LTR marks
    if (!line.trim()) continue;

    const m = line.match(LINE_RE_ANDROID) || line.match(LINE_RE_IOS);
    if (m) {
      if (current) messages.push(current);
      const [, date, time, sender, body] = m;
      current = { seq: seq++, ts: `${date}, ${time}`, sender: sender.trim(), body, is_system: isSystemLine(body) };
    } else if (current) {
      // Continuation line of a multiline message.
      current.body += `\n${line}`;
    }
    // Stray lines before the first matched message (rare) are dropped.
  }
  if (current) messages.push(current);
  return messages;
}

module.exports = { parseWhatsAppExport };
