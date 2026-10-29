/**
 * Vercel Blob 适配器：把 SDK 的 get/put 包装成持久预算要的那两个动作。
 *
 * 凭据：**一个 token 变量都不碰**。官方文档说得很明确：SDK 会自动用项目 OIDC
 * （`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`），并在过期时自己刷新；手动把 oidcToken
 * 传给 SDK 会**绕过**这个刷新，token 一过期所有调用就 403。所以这里只让 SDK 自己读环境。
 *
 * 读：`get(path, { access: 'private', useCache: false })` → 读最新（绕 CDN 缓存），
 * 返回 body 流 + `blob.etag`；同一次读里 etag 与内容是同一份，不会各读各的。
 * 写：`put(path, body, { access: 'private', allowOverwrite: true, addRandomSuffix: false,
 * ifMatch: etag })` → 原子 CAS；etag 对不上时 SDK 抛 `BlobPreconditionFailedError`。
 */
import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from '@vercel/blob';

/**
 * 建一个存储适配器。
 *
 * @param {{get: Function, put: Function, BlobNotFoundError: Function,
 *          BlobPreconditionFailedError: Function}} [sdk] 注入 SDK（测试用假实现）
 */
export function createBlobStore(sdk = { get, put, BlobNotFoundError, BlobPreconditionFailedError }) {
  return {
    async get(path, options = {}) {
      let result;
      try {
        result = await sdk.get(path, {
          access: options.access ?? 'private',
          // 读最新：拿旧 etag 去写，CAS 就没意义了。
          useCache: options.useCache ?? false,
        });
      } catch (error) {
        // 没有这个文件 = "还没初始化"，不是错误。
        if (error instanceof sdk.BlobNotFoundError) return null;
        throw error;
      }
      if (result === null || result === undefined) return null;
      return {
        body: result.stream,
        etag: result.blob?.etag,
        // **原样带上状态码，不许伪造 200**：SDK 的 get 是按 statusCode 判别的联合类型，
        // 200 给完整内容，304 表示"没改动"（stream 为 null，没有内容可读）。
        // 304 不是账本 → 上层会按读失败处理（失败关闭），不能当成一次正常读。
        status: result.statusCode,
      };
    },

    async put(path, body, options = {}) {
      try {
        const blob = await sdk.put(path, body, {
          access: options.access ?? 'private',
          addRandomSuffix: options.addRandomSuffix === true,
          allowOverwrite: options.allowOverwrite === true,
          ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
        });
        return { etag: blob.etag };
      } catch (error) {
        // etag 对不上 = 别人先改了。归一成"冲突"，让上层按失败关闭处理。
        if (error instanceof sdk.BlobPreconditionFailedError) {
          throw Object.assign(new Error('etag conflict'), { status: 412, code: 'conflict' });
        }
        throw error;
      }
    },
  };
}
