export function parseInviteOrigin(value) {
  if (typeof value !== 'string') throw new Error('请输入邀请地址。');
  const address = value.trim();
  if (!/^https?:\/\/[^\s/?#@\\]+\/?$/i.test(address) || address.length > 512) {
    throw new Error('请填写以 http:// 或 https:// 开头的入口地址，只保留主机名和端口。');
  }
  return new URL(address).origin;
}
