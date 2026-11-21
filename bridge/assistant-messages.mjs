// Human-facing semantics shared by both adapters. Native identities and settings stay separate.
export const assistantMessages = Object.freeze({
  permission: '等待授权，请在原客户端处理。',
  timeout: '等待超时，任务可能仍在执行；请查看原客户端，不要重复发送。',
  unknown: '发送或回复状态未确认，请查看原客户端，不要重复发送。',
  error: '本轮执行失败，请查看原客户端。',
  failed: '本轮未正常完成，请查看原客户端。',
  working: '任务仍在处理，请查看原客户端，不要重复发送。',
  queued: '消息已排队，等待原客户端接收；不要重复发送。',
  busy: 'Agent 正在执行，请等待完成并查看原会话。',
  offline: '电脑正在恢复连接，本次未提交；请稍后核对原客户端再发送。',
  connectionLost: '连接已中断，结果暂未确认；请查看原客户端，不要重复发送。',
  previousUnknown: '上一条请求结果不明，请先在原客户端核对；不要重复发送。',
  storage: '电脑未能保存选择或请求记录，本次未提交；请检查电脑存储。',
});

export function assistantHelp({ search = false, creation = false, shortcuts = false } = {}) {
  return '可说当前模式、当前项目、当前 Agent、列出项目、列出 Agent、最近对话、选择 1、下一页、上一页。'
    + (search ? '查找对话后接项目或主题。' : '')
    + (creation ? '新建对话后接名称。' : '')
    + (shortcuts ? '快捷短语可进入已绑定的项目或 Agent。' : '')
    + '需要输入内容的操作说完后，单独说确认发送。先列出名单，再按当前页编号选择。'
    + '取消发送只清空未发送内容；结束对话退出眼镜操作。已发送任务不会因此停止。';
}
