export const SERVER_INSTRUCTIONS =
  'Naver Mail (네이버 메일) tools with the same names and inputs as the Gmail MCP. ' +
  'Typical flow: search_threads (Gmail query syntax) → get_thread with PLAIN_TEXT → act (reply, label_message, trash_message …). ' +
  'Labels are folders in Naver Mail: adding a folder label moves the message and changes its id (the new id is returned). ' +
  'Always confirm recipients and content with the user before send_message, reply or forward.';
