import { AsyncLocalStorage } from 'node:async_hooks';

export const UNASSIGNED_PROJECT = '未归属项目';
const requestLocale = new AsyncLocalStorage();

const messages = {
  upstreamFailed: [
    (method, message) => `ConversationService.${method} 失败: ${message}`,
    (method, message) => `ConversationService.${method} failed: ${message}`,
  ],
  upstreamInvalidResponse: [
    (method) => `ConversationService.${method} 返回了无效数据`,
    (method) => `ConversationService.${method} returned an invalid response`,
  ],
  upstreamInvalidList: [
    'ConversationService.ListConversations 返回了无效会话列表',
    'ConversationService.ListConversations returned an invalid conversation list',
  ],
  upstreamInvalidPageToken: [
    'ConversationService.ListConversations 返回了无效分页标记',
    'ConversationService.ListConversations returned an invalid page token',
  ],
  metaRead: ['无法读取本地标签和备注文件 meta.json', 'Could not read the local tags and notes file meta.json'],
  metaInvalid: [
    '本地标签和备注文件 meta.json 格式无效，已保留原文件',
    'Invalid format in the local tags and notes file meta.json. The original file was kept',
  ],
  metaInvalidShape: ['无效会话元数据', 'Invalid conversation metadata'],
  metaInvalidEntry: ['无效标签或备注', 'Invalid tags or note'],
  metaWrite: ['无法保存本地标签和备注文件 meta.json', 'Could not save the local tags and notes file meta.json'],
  invalidLanguage: ['不支持此语言，请选择简体中文或 English', 'Unsupported language. Choose Simplified Chinese or English'],
  preferencesRead: ['无法读取语言偏好文件 preferences.json', 'Could not read language preferences from preferences.json'],
  preferencesInvalid: ['语言偏好文件 preferences.json 格式无效', 'Invalid language preferences in preferences.json'],
  preferencesWrite: ['无法保存语言偏好文件 preferences.json', 'Could not save language preferences to preferences.json'],
  staleSubagent: ['子代理会话不参与闲置归档', 'Subagent conversations are excluded from idle archiving'],
  staleArchived: ['会话已归档', 'The conversation is already archived'],
  stalePinned: ['会话已置顶', 'The conversation is pinned'],
  staleStarred: ['会话已加星标', 'The conversation is starred'],
  staleRunning: ['会话正在运行', 'The conversation is running'],
  staleUnknown: ['无法确认会话已停止', 'Could not confirm the conversation has stopped'],
  staleRecent: [
    (days) => `会话闲置时间不足 ${days} 天`,
    (days) => `The conversation has been idle for less than ${days} ${days === 1 ? 'day' : 'days'}`,
  ],
  unassignedProject: [UNASSIGNED_PROJECT, 'No project'],
  ungrouped: ['未分组', 'Ungrouped'],
  keywordFallback: ['关键词索引不可用，已按正文逐词匹配', 'Keyword indexing is unavailable. Words were matched against the stored text'],
  invalidTags: ['标签必须是字符串数组', 'Tags must be an array of strings'],
  invalidTagResolution: ['无效的标签处理方式', 'Invalid tag resolution'],
  missingLocalTags: ['没有可推送的本地标签', 'There are no local tags to send'],
  unconfirmedTags: ['无法确认宿主标签，已保留本地数据', 'Could not verify the host tags. Local data was retained'],
  deleteArchivedOnly: ['仅可批量删除已归档会话', 'Only archived conversations can be batch deleted'],
  deleteSubagent: ['不能删除子代理会话', 'Subagent conversations cannot be deleted'],
  alreadyGone: ['会话已不存在', 'The conversation is already gone'],
  deleteRemains: ['删除后会话仍然存在', 'The conversation still exists after deletion'],
  deleteUnknown: ['无法确认删除结果，请刷新后核对', 'Could not verify deletion. Refresh to check the conversation'],
  deleteRecovered: [(id, reason) => `会话 ${id} 已确认不存在。删除请求返回错误：${reason}`, (id, reason) => `Conversation ${id} is confirmed gone. The delete request reported an error: ${reason}`],
  untitled: ['未命名会话', 'Untitled conversation'],
  transcriptUnreadable: [(file) => `无法读取 ${file}`, (file) => `Could not read ${file}`],
  transcriptInvalidRecord: ['无效记录', 'Invalid transcript record'],
  transcriptInvalidText: ['无效文本', 'Invalid transcript text'],
  transcriptMalformed: [
    (file, count) => `${file} 有 ${count} 行无法解析，记录可能不完整`,
    (file, count) => `Could not parse ${count} ${count === 1 ? 'line' : 'lines'} in ${file}. The transcript may be incomplete`,
  ],
  ftsUnreadable: ['无法读取全文索引（FTS）', 'Could not read the full-text search (FTS) index'],
  ftsOnly: ['内容来自全文索引（FTS）摘要，可能不完整', 'These excerpts are from the full-text search (FTS) index and may be incomplete'],
  transcriptMissing: ['未找到可预览的对话正文', 'No transcript content was found to preview'],
  transcriptMerged: ['正文由完整与精简记录合并，可能不完整', 'This transcript combines the full and compact logs and may be incomplete'],
  transcriptConflict: [
    '两份记录的消息无法可靠对齐，已保留 transcript_full.jsonl 中可读取的正文',
    'The two logs could not be aligned reliably. Readable messages from transcript_full.jsonl were kept',
  ],
  transcriptCompact: ['正文来自精简记录，可能不完整', 'This transcript is from the compact log and may be incomplete'],
  conversationNotFound: [(id) => `未找到会话: ${id}`, (id) => `Conversation not found: ${id}`],
  exportProject: ['所属项目', 'Project'],
  exportArchiveStatus: ['归档状态', 'Archive status'],
  exportArchived: ['已归档', 'Archived'],
  exportUnarchived: ['未归档', 'Unarchived'],
  exportPinStatus: ['置顶状态', 'Pin status'],
  exportPinned: ['已置顶', 'Pinned'],
  exportStarStatus: ['收藏状态', 'Star status'],
  exportStarred: ['已星标收藏', 'Starred'],
  exportUpdated: ['最后更新', 'Last updated'],
  exportTags: ['标签', 'Tags'],
  exportNote: ['备注', 'Note'],
  exportSource: ['对话来源', 'Transcript source'],
  exportWarning: ['提示', 'Warning'],
  missingConversationId: ['缺少 conversationId', 'Missing conversationId'],
  invalidUndoRequest: ['无效的撤销请求', 'Invalid undo request'],
  invalidUndoRecord: ['无效的撤销记录', 'Invalid undo record'],
  conflictingUndo: [(id) => `会话 ${id} 的撤销记录互相冲突`, (id) => `Conflicting undo records for conversation ${id}`],
  missingArchiveState: ['缺少有效的 archived 状态', 'A valid archived state is required'],
  missingStaleDays: ['闲置归档需要有效的闲置天数', 'Idle archiving requires a valid number of idle days'],
  unknownArchiveState: ['无法确认会话的归档状态', 'Could not confirm the conversation’s archive state'],
  unknownConversation: ['无法确认上游返回的会话信息', 'Could not verify the conversation returned by Antigravity'],
  unexpectedArchiveState: ['上游返回的归档状态未发生预期变化', 'Antigravity returned an unexpected archive state'],
  runningArchive: ['该会话正在运行中，请先停止后再归档', 'This conversation is running. Stop it before archiving'],
  runningDelete: ['该会话正在运行中，请先停止后再删除', 'This conversation is running. Stop it before deleting'],
  unknownArchive: ['无法确认会话已停止，未归档', 'Could not confirm the conversation has stopped. Archiving was skipped'],
  unknownDelete: ['无法确认会话已停止，未删除', 'Could not confirm the conversation has stopped. Deletion was skipped'],
  undoStateChanged: ['归档状态已变化，无法撤销', 'The archive state has changed. This change can no longer be undone'],
  pathNotFound: [(path) => `路径不存在: ${path}`, (path) => `Path does not exist: ${path}`],
};

export function isSupportedLanguage(value) {
  return value === 'zh-CN' || value === 'en';
}

export function withRequestLocale(handler) {
  return (data) => requestLocale.run(data?.locale === 'en' ? 'en' : 'zh-CN', () => handler(data ?? {}));
}

export function getRequestLanguage() {
  return requestLocale.getStore() ?? 'zh-CN';
}

export function t(key, ...args) {
  const template = messages[key][getRequestLanguage() === 'en' ? 1 : 0];
  return typeof template === 'function' ? template(...args) : template;
}
