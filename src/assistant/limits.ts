/**
 * The limits on a conversation the view sends an assistant, shared by the
 * route that checks them and the view that keeps within them. Imports
 * nothing, so the view's bundle takes nothing of the server's with it.
 */

/** The longest conversation the view may send, in messages. */
export const MAX_MESSAGES = 40;

/** The longest thing the person may say in one message, in characters. */
export const MAX_MESSAGE_LENGTH = 8_000;

/**
 * The longest answer the view may send back as part of the conversation, in
 * characters: an answer can hold a whole page the model drafted.
 */
export const MAX_ANSWER_LENGTH = 64_000;

/** The longest conversation the view may send, in characters all told. */
export const MAX_CONVERSATION_LENGTH = 200_000;
