'use strict';

class AuthorizationGate {
  constructor({ allowedUserIds = [], allowedChatIds = [], allowAll = false } = {}) {
    this.users = new Set(allowedUserIds.map(String));
    this.chats = new Set(allowedChatIds.map(String));
    this.allowAll = allowAll === true;
  }

  isAllowed({ userId, chatId } = {}) {
    if (this.allowAll) return true;
    if (!this.users.size && !this.chats.size) return false;
    return (!this.users.size || (userId !== undefined && this.users.has(String(userId)))) &&
      (!this.chats.size || (chatId !== undefined && this.chats.has(String(chatId))));
  }

  isChatAllowed(chatId) {
    if (this.allowAll) return true;
    if (!this.chats.size) return false;
    return chatId !== undefined && chatId !== null && this.chats.has(String(chatId));
  }

  filterChatIds(chatIds = []) {
    const list = Array.isArray(chatIds) ? chatIds : [chatIds];
    return [...new Set(list.filter(id => id !== undefined && id !== null).map(String))].filter(id => this.isChatAllowed(id));
  }

  identityFromUpdate(update = {}) {
    const message = update.message || update.edited_message || update.callback_query?.message || {};
    return { userId: update.callback_query?.from?.id ?? message.from?.id, chatId: message.chat?.id };
  }

  assertAllowed(identity) {
    if (!this.isAllowed(identity)) {
      const error = new Error('Unauthorized Telegram identity');
      error.code = 'UNAUTHORIZED';
      throw error;
    }
    return true;
  }

  assertUpdateAllowed(update) { return this.assertAllowed(this.identityFromUpdate(update)); }
}

module.exports = { AuthorizationGate };
