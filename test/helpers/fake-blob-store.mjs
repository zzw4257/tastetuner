/**
 * 假存储适配器：内存里的 blob 表，带 etag 与 CAS 语义。
 *
 * 只在本地测试里用（服务端进程把它当"真存储"加载），
 * 用来验证接线与失败关闭路径——**不碰任何云，也不发任何 Qloo 请求**。
 */
const blobs = new Map();
let counter = 0;

export function createBlobStore() {
  return {
    async get(path) {
      const blob = blobs.get(path);
      if (blob === undefined) return null;
      return { body: new Response(blob.body).body, etag: blob.etag, status: 200 };
    },
    async put(path, body, options = {}) {
      const existing = blobs.get(path);
      if (options.ifMatch !== undefined) {
        if (existing === undefined || existing.etag !== options.ifMatch) {
          throw Object.assign(new Error('conflict'), { status: 412 });
        }
      }
      if (existing !== undefined && options.allowOverwrite === false) {
        throw Object.assign(new Error('already exists'), { status: 409 });
      }
      counter += 1;
      const etag = `etag-${counter}`;
      blobs.set(path, { body: String(body), etag });
      return { etag };
    },
  };
}
