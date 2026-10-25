import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NaverMailService } from './mail/service';

/**
 * Gmail MCP와 같은 도구 이름·입력으로 네이버 메일 도구를 등록한다.
 * 에이전트가 Gmail에서 쓰던 흐름(search_threads → get_thread → reply …)을 그대로 쓸 수 있게 한다.
 */

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

const emails = (what: string) => z.array(z.string()).optional().describe(`${what}. Plain email addresses (e.g. "user@example.com"); "Name <user@example.com>" also works.`);

const attachment = z.object({
  content: z.string().describe('Base64-encoded file content.'),
  filename: z.string().optional().describe('File name shown to recipients, e.g. "invoice.pdf".'),
  mimeType: z.string().optional().describe('IANA MIME type. Defaults to application/octet-stream.'),
  inline: z.boolean().optional().describe('If true, an inline image referenced from htmlBody as <img src="cid:N"> where N is its zero-based index in attachments.'),
});
const attachments = z.array(attachment).optional().describe('Attachments. Combined size must not exceed 25MB.');

const messageFormat = z
  .enum(['MESSAGE_FORMAT_UNSPECIFIED', 'MINIMAL', 'FULL_CONTENT', 'METADATA_ONLY', 'PLAIN_TEXT', 'RAW'])
  .optional()
  .describe(
    'MINIMAL: subject, snippet, sender, recipients, date, labels. METADATA_ONLY: no subject/snippet/body. PLAIN_TEXT (recommended): MINIMAL + plaintextBody + attachments (HTML converted to text if needed). FULL_CONTENT (default): also htmlBody. RAW: raw MIME.',
  );

const body = z.string().optional().describe('Plain text body. Do NOT format with Markdown; use htmlBody for rich text. If htmlBody is also given, this is the plain-text alternative.');
const htmlBody = z.string().optional().describe('HTML body (valid HTML tags).');

const QUERY_HELP =
  'Gmail search syntax, converted to IMAP for Naver Mail. Supported: from:, to:, cc:, bcc:, subject:, "exact phrase", bare keywords, ' +
  'after:YYYY/MM/DD (inclusive), before:YYYY/MM/DD (exclusive), newer_than:/older_than: (e.g. 7d, 2m, 1y), is:unread, is:read, is:starred, has:attachment, ' +
  'filename:, larger:/smaller: (e.g. 5M), in:inbox|sent|trash|spam|draft|anywhere, label:<folder name>, OR, { }, -exclude, ( ). ' +
  'Bare keywords match subject, sender or body. has:attachment/filename: check message structure of the newest 3000 messages per folder (add a date filter for older mail). ' +
  'Default scope: all folders except trash, spam and drafts. Unsupported operators (category:, AROUND …) are ignored and reported in warnings. Prefer short keyword queries.';

export function registerTools(server: McpServer, svc: () => NaverMailService) {
  const ro = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'get_profile',
    { description: "Returns the connected Naver Mail address, total messages and unread count in the inbox. Use it to confirm which account is connected.", inputSchema: {}, annotations: ro },
    async () => json(await svc().getProfile()),
  );

  server.registerTool(
    'search_threads',
    {
      description:
        'IMPORTANT: results are previews (up to 5 messages per thread, from this page only). Never answer questions about the latest or unread email from previews alone; call get_thread to read relevant threads in full. ' +
        'Lists email threads in the Naver Mail account matching a query, newest first, with pagination. Each thread has its id, messageCount (messages from this page) and messages with id, sender, recipients, date, labelIds, subject and snippet. ' +
        'Use it to find thread ids before reading full threads or acting on emails.',
      inputSchema: {
        query: z.string().optional().describe(QUERY_HELP),
        pageSize: z.number().int().min(1).max(50).optional().describe('Max messages to return (grouped into threads). Default 20, max 50.'),
        pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
        includeTrash: z.boolean().optional().describe('Include messages in Trash. Default false.'),
        view: z.enum(['THREAD_VIEW_UNSPECIFIED', 'THREAD_VIEW_METADATA_ONLY', 'THREAD_VIEW_MINIMAL']).optional().describe('THREAD_VIEW_MINIMAL (default) includes subject and snippet; THREAD_VIEW_METADATA_ONLY excludes them.'),
      },
      annotations: ro,
    },
    async (a) => json(await svc().searchThreads(a)),
  );

  server.registerTool(
    'get_thread',
    {
      description:
        'Retrieves an email thread (conversation) with all its messages, oldest first, across folders (inbox, sent, user folders). Drafts are omitted. Threads are reconstructed from Message-ID/References headers. Use PLAIN_TEXT to save context.',
      inputSchema: { threadId: z.string().describe('Thread id from search_threads.'), messageFormat },
      annotations: ro,
    },
    async (a) => json(await svc().getThread(a.threadId, a.messageFormat)),
  );

  server.registerTool(
    'get_message',
    {
      description: 'Retrieves a single email message by id, including body and attachment metadata. For whole conversations use get_thread. Use PLAIN_TEXT to prevent context exhaustion.',
      inputSchema: { messageId: z.string().describe('Message id from search_threads or get_thread.'), messageFormat },
      annotations: ro,
    },
    async (a) => json(await svc().getMessage(a.messageId, a.messageFormat)),
  );

  server.registerTool(
    'get_attachment',
    {
      description: 'Downloads one attachment of a message. Returns text for text-like files (txt, csv, html, json, ics) and base64 data (up to 8MB).',
      inputSchema: { messageId: z.string(), attachmentId: z.string().describe('attachmentId from get_message (zero-based index).') },
      annotations: ro,
    },
    async (a) => json(await svc().getAttachment(a.messageId, a.attachmentId)),
  );

  server.registerTool(
    'list_labels',
    {
      description:
        'Lists labels with message and unread counts. In Naver Mail labels are folders: system labels INBOX, SENT, DRAFT, TRASH, SPAM map to the matching folders; user labels are folder paths. STARRED (important mark) and UNREAD are flags. Use the returned id with label tools.',
      inputSchema: {},
      annotations: ro,
    },
    async () => json(await svc().listLabels()),
  );

  server.registerTool(
    'create_label',
    {
      description: "Creates a new user label (a Naver Mail folder). Nested labels use '/', e.g. 'Projects/Alpha'; missing parents are created.",
      inputSchema: { displayName: z.string().describe("Label name, e.g. 'Receipts' or 'Projects/Alpha'.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => json(await svc().createLabel(a.displayName)),
  );

  server.registerTool(
    'update_label',
    {
      description: 'Renames a user label (folder).',
      inputSchema: { labelId: z.string().describe('User label id from list_labels.'), displayName: z.string().describe('New name.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => json(await svc().updateLabel(a.labelId, a.displayName)),
  );

  server.registerTool(
    'delete_label',
    {
      description: 'Deletes a user label. WARNING: in Naver Mail a label is a folder, so the messages inside it are deleted too. Confirm with the user first.',
      inputSchema: { labelId: z.string().describe('User label id from list_labels.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) => json(await svc().deleteLabel(a.labelId)),
  );

  const labelIdsDesc =
    'Label ids: STARRED, UNREAD, INBOX, TRASH, SPAM, or a user label id from list_labels. Adding a folder label moves the message to that folder (one folder per message); removing the current folder label moves it back to INBOX.';
  const moveNote = ' Moving changes the message id; the new id is returned.';

  server.registerTool(
    'label_message',
    {
      description: 'Adds labels to a message: STARRED marks important, UNREAD marks unread, a folder label moves it.' + moveNote,
      inputSchema: { messageId: z.string(), labelIds: z.array(z.string()).min(1).describe(labelIdsDesc) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => json(await svc().updateMessageLabels(a.messageId, a.labelIds, [])),
  );

  server.registerTool(
    'unlabel_message',
    {
      description: 'Removes labels from a message, e.g. remove UNREAD to mark as read, STARRED to unstar.' + moveNote,
      inputSchema: { messageId: z.string(), labelIds: z.array(z.string()).min(1).describe(labelIdsDesc) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => json(await svc().updateMessageLabels(a.messageId, [], a.labelIds)),
  );

  server.registerTool(
    'update_message_labels',
    {
      description: 'Adds and/or removes labels on a message in one call.' + moveNote,
      inputSchema: { messageId: z.string(), addLabelIds: z.array(z.string()).optional().describe(labelIdsDesc), removeLabelIds: z.array(z.string()).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      if (!a.addLabelIds?.length && !a.removeLabelIds?.length) throw new Error('addLabelIds 또는 removeLabelIds 중 하나는 필요합니다');
      return json(await svc().updateMessageLabels(a.messageId, a.addLabelIds, a.removeLabelIds));
    },
  );

  server.registerTool(
    'label_thread',
    {
      description: 'Adds labels to every message in a thread (e.g. STARRED, or a folder label to move the conversation).',
      inputSchema: { threadId: z.string(), labelIds: z.array(z.string()).min(1).describe(labelIdsDesc) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => json(await svc().updateThreadLabels(a.threadId, a.labelIds, [])),
  );

  server.registerTool(
    'unlabel_thread',
    {
      description: 'Removes labels from every message in a thread, e.g. remove UNREAD to mark the whole conversation as read.',
      inputSchema: { threadId: z.string(), labelIds: z.array(z.string()).min(1).describe(labelIdsDesc) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => json(await svc().updateThreadLabels(a.threadId, [], a.labelIds)),
  );

  const soft = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  server.registerTool(
    'trash_message',
    { description: "Moves a message to Trash (soft delete). Default tool when the user asks to delete a message without asking for permanent deletion.", inputSchema: { messageId: z.string() }, annotations: soft },
    async (a) => json(await svc().updateMessageLabels(a.messageId, ['TRASH'], [])),
  );
  server.registerTool(
    'trash_thread',
    { description: 'Moves every message of a thread to Trash (soft delete).', inputSchema: { threadId: z.string() }, annotations: soft },
    async (a) => json(await svc().updateThreadLabels(a.threadId, ['TRASH'], [])),
  );
  server.registerTool(
    'untrash_message',
    { description: 'Moves a message out of Trash (to Sent if you sent it, otherwise Inbox).', inputSchema: { messageId: z.string() }, annotations: soft },
    async (a) => json(await svc().restoreMessage(a.messageId, 'TRASH')),
  );
  server.registerTool(
    'untrash_thread',
    { description: 'Moves the messages of a thread out of Trash.', inputSchema: { threadId: z.string() }, annotations: soft },
    async (a) => json(await svc().restoreThread(a.threadId, 'TRASH')),
  );
  server.registerTool(
    'mark_message_spam',
    { description: 'Moves a message to the Spam folder.', inputSchema: { messageId: z.string() }, annotations: soft },
    async (a) => json(await svc().updateMessageLabels(a.messageId, ['SPAM'], [])),
  );
  server.registerTool(
    'mark_thread_spam',
    { description: 'Moves every message of a thread to the Spam folder.', inputSchema: { threadId: z.string() }, annotations: soft },
    async (a) => json(await svc().updateThreadLabels(a.threadId, ['SPAM'], [])),
  );
  server.registerTool(
    'unmark_message_spam',
    { description: 'Moves a message out of Spam back to the Inbox.', inputSchema: { messageId: z.string() }, annotations: soft },
    async (a) => json(await svc().restoreMessage(a.messageId, 'SPAM')),
  );
  server.registerTool(
    'unmark_thread_spam',
    { description: 'Moves the messages of a thread out of Spam.', inputSchema: { threadId: z.string() }, annotations: soft },
    async (a) => json(await svc().restoreThread(a.threadId, 'SPAM')),
  );

  const send = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

  server.registerTool(
    'send_message',
    {
      description:
        'Sends an email immediately from the Naver Mail account (SMTP) and saves a copy in Sent. To send an existing draft, give draftId. To thread under an existing conversation give replyThreadId or replyToMessageId. Confirm recipients and content with the user before sending.',
      inputSchema: {
        to: emails('Primary recipients. Required unless draftId is given'),
        cc: emails('Cc recipients'),
        bcc: emails('Bcc recipients'),
        subject: z.string().optional(),
        body,
        htmlBody,
        attachments,
        draftId: z.string().optional().describe('Send this draft as is; other fields are ignored. The draft is removed after sending.'),
        replyToMessageId: z.string().optional().describe('Thread the message as a reply to this message.'),
        replyThreadId: z.string().optional().describe('Thread the message under this thread (replies to its latest message).'),
      },
      annotations: send,
    },
    async (a) => json(await svc().sendMessage(a)),
  );

  server.registerTool(
    'reply',
    {
      description:
        'Replies to a message (to the sender, or everyone with replyAll). The original is quoted below the reply and threading headers are set. To reply in a thread, use the id of its latest message from get_thread. body or htmlBody is required. Confirm with the user before sending.',
      inputSchema: {
        messageId: z.string(),
        body,
        htmlBody,
        replyAll: z.boolean().optional().describe('Reply to all recipients. Default false.'),
        to: emails('Overrides the default reply recipients'),
        cc: emails('Overrides the default Cc recipients'),
        bcc: emails('Bcc recipients'),
        attachments,
      },
      annotations: send,
    },
    async (a) => json(await svc().reply(a)),
  );

  server.registerTool(
    'forward',
    {
      description: 'Forwards a message with its original attachments. Optional comments go above the forwarded message via forwardText (plain) or htmlBody. Confirm with the user before sending.',
      inputSchema: {
        messageId: z.string(),
        to: emails('Primary recipients'),
        cc: emails('Cc recipients'),
        bcc: emails('Bcc recipients'),
        forwardText: z.string().optional().describe('Plain text comments above the forwarded message. No Markdown.'),
        htmlBody: z.string().optional().describe('HTML comments above the forwarded message.'),
        attachments: z.array(attachment).optional().describe('Extra attachments in addition to the original ones (25MB total).'),
      },
      annotations: send,
    },
    async (a) => json(await svc().forward(a)),
  );

  const draftWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  server.registerTool(
    'create_draft',
    {
      description:
        'Creates a draft in the Naver Mail drafts folder (임시보관함). If replyToMessageId is given, threading headers are set and the original message is quoted below the body; recipients default to the original sender. Returns the draft id.',
      inputSchema: { to: emails('Primary recipients'), cc: emails('Cc recipients'), bcc: emails('Bcc recipients'), subject: z.string().optional(), body, htmlBody, attachments, replyToMessageId: z.string().optional() },
      annotations: draftWrite,
    },
    async (a) => json(await svc().createDraft(a)),
  );

  server.registerTool(
    'update_draft',
    {
      description:
        'Updates a draft with merge semantics: given (non-empty) fields overwrite, omitted fields are kept. If only body is given the HTML body is cleared. WARNING: attachments are NOT merged; re-provide them or they are removed. The draft id changes (returned).',
      inputSchema: { draftId: z.string(), to: emails('Primary recipients'), cc: emails('Cc recipients'), bcc: emails('Bcc recipients'), subject: z.string().optional(), body, htmlBody, attachments },
      annotations: draftWrite,
    },
    async (a) => json(await svc().updateDraft(a)),
  );

  server.registerTool(
    'delete_draft',
    { description: 'Deletes a draft.', inputSchema: { draftId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
    async (a) => json(await svc().deleteDraft(a.draftId)),
  );

  server.registerTool(
    'list_drafts',
    {
      description: 'Lists drafts, optionally filtered by a query (same syntax as search_threads).',
      inputSchema: {
        query: z.string().optional(),
        pageSize: z.number().int().min(1).max(50).optional().describe('Default 20, max 50.'),
        pageToken: z.string().optional(),
        view: z.enum(['DRAFT_VIEW_UNSPECIFIED', 'DRAFT_VIEW_METADATA_ONLY', 'DRAFT_VIEW_FULL']).optional().describe('DRAFT_VIEW_FULL adds subject and plaintextBody.'),
      },
      annotations: ro,
    },
    async (a) => json(await svc().listDrafts(a)),
  );

  server.registerTool(
    'get_draft',
    { description: 'Retrieves a draft by id.', inputSchema: { draftId: z.string(), messageFormat }, annotations: ro },
    async (a) => json(await svc().getMessage(a.draftId, a.messageFormat)),
  );
}
