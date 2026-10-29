/**
 * Vercel Function 入口：把 /api/* 交给应用自己的处理逻辑。
 *
 * 静态资源由平台托管（构建输出目录），这里只管接口。
 * 处理器在模块级缓存一次：实例内复用同一份适配器与共享预算；
 * 共享预算本身无状态（计数在共享存储里），所以复用是安全的。
 */
import { createPlatformHandler } from '../scripts/platform-handler.mjs';

let handlerPromise;

export default async function handler(req, res) {
  handlerPromise ??= createPlatformHandler();
  const handle = await handlerPromise;
  await handle(req, res);
}
