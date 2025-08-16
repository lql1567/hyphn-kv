import { Context } from 'hono';

const VALID_TYPES = [
  'news',
  'ask',
  'show',
  'front-page'
];

/**
 * GET /api/posts?type=xxx
 * 从KV缓存获取对应type的数据
 */
export const getPostsHandler = async (c: Context) => {
  try {
    const type = c.req.query('type');

    if (!type || !VALID_TYPES.includes(type)) {
      return c.json({
        error: 'Invalid type',
        message: `type参数必须为: ${VALID_TYPES.join(', ')}`
      }, 400);
    }

    // 获取KV命名空间
    const kv = c.env?.HPYHN_KV;
    if (!kv) {
      return c.json({
        error: 'KV not configured',
        message: '未找到KV命名空间'
      }, 500);
    }

    // 从KV获取数据
    const kvValue = await kv.get(type);

    return c.json(JSON.parse(kvValue));
  } catch (error) {
    console.error('Error in getPostsHandler:', error);
    return c.json({
      error: 'Internal Server Error',
      message: '获取数据时发生错误'
    }, 500);
  }
};
