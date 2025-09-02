/*
### 业务需求
需要增加一个dont_miss的接口导出，POST接口，请求报文是：
{
      "user_id": user_id,
       "posts": [
        {
            "id": int,
            "score":float,
            ....
        }
       ]
}
### 业务逻辑
1. 将报文解析成json然后以user_id为key，posts的值为value，组成的kv数据插入到名字为
   HPYHN_DONTMISS_POSTS的cloudflare workder KV缓存中
2. 将posts里面的id和score，单独拉出来组成一个josn数组[{"id":..., "score":...}]
3. 以user_id为key，查找HPYHN_INTERESTS_SCORE缓存中的数据，数据是一个json对象，
   这个对象里面查找key为dont-miss的数据，如果没有则插入第二步的json数据作为value，key为dont-miss
   如果有则进行整合去重。最后将结果更新到HPYHN_INTERESTS_SCORE缓存中

### 代码实现

*/
import { Context } from 'hono';

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string, options?: { type: 'text' | 'json' | 'arrayBuffer' }): Promise<any>;
  put(key: string, value: string | ReadableStream, options?: { expiration?: number; expirationTtl?: number; metadata?: any }): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string; expiration?: number; metadata?: any }>; list_complete: boolean; cursor?: string }>;
}

interface Env {
  HPYHN_DONTMISS_POSTS: KVNamespace;
  HPYHN_INTERESTS_SCORE: KVNamespace;
}

export const dont_miss = async (c: Context) => {
  const env = c.env as Env;

  if (c.req.method === 'GET') {
    try {
      const user_id = c.req.query('user_id');
      const queryCount = c.req.query('queryCount');

      if (!user_id) {
        return c.json({ success: false, error: 'Missing required query parameter: user_id' }, 400);
      }

      if (queryCount === 'true') {
        const existingDontMissPosts = await env.HPYHN_DONTMISS_POSTS.get(user_id);
        let dontMissData = existingDontMissPosts ? JSON.parse(existingDontMissPosts) : [];
        return c.json({ success: true, user_id, count: dontMissData.length });
      } else {
        return c.json({ success: false, error: 'Invalid query parameter: queryCount. Must be "true" for this endpoint.' }, 400);
      }
    } catch (error) {
      console.error('Error in dont_miss GET:', error);
      return c.json({ success: false, error: 'Failed to retrieve dont-miss count', details: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  } else if (c.req.method === 'POST') {
    try {
      const { user_id, posts } = await c.req.json();

      if (!user_id || !posts || !Array.isArray(posts)) {
        return c.json({ success: false, error: 'Missing required parameters: user_id or posts (must be an array)' }, 400);
      }

      // 1. 将报文解析成json然后以user_id为key，posts的值为value，
      // 组成的kv数据插入到名字为HPYHN_DONTMISS_POSTS的cloudflare workder KV缓存中
      await env.HPYHN_DONTMISS_POSTS.put(user_id, JSON.stringify(posts));
      console.log(`Stored dont-miss posts for user ${user_id} in HPYHN_DONTMISS_POSTS`);

      // 2. 将posts里面的id和score，单独拉出来组成一个josn数组[{"id":..., "score":...}]
      const idScorePosts = posts.map((post: any) => ({ id: post.id, score: post.score }));

      // 3. 以user_id为key，查找HPYHN_INTERESTS_SCORE缓存中的数据，数据是一个json对象，
      //    这个对象里面查找key为dont-miss的数据，如果没有则插入第二步的json数据作为value，key为dont-miss
      //    如果有则进行整合去重。最后将结果更新到HPYHN_INTERESTS_SCORE缓存中
      const existingInterestScoreData = await env.HPYHN_INTERESTS_SCORE.get(user_id);
      let userInterestScores: { [key: string]: any[] } = existingInterestScoreData ? JSON.parse(existingInterestScoreData) : {};

      const existingDontMiss = userInterestScores['dont-miss'] || [];

      // Merge and de-duplicate
      const mergedDontMiss = [...existingDontMiss, ...idScorePosts];
      const uniqueDontMiss = Array.from(new Map(mergedDontMiss.map(item => [item.id, item])).values());

      userInterestScores['dont-miss'] = uniqueDontMiss;

      await env.HPYHN_INTERESTS_SCORE.put(user_id, JSON.stringify(userInterestScores));
      console.log(`Updated dont-miss interest score for user ${user_id} in HPYHN_INTERESTS_SCORE`);

      return c.json({ success: true, message: 'Dont-miss data processed successfully', user_id, posts: uniqueDontMiss });

    } catch (error) {
      console.error('Error in dont_miss POST:', error);
      return c.json({ success: false, error: 'Failed to process dont-miss request', details: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  } else if (c.req.method === 'DELETE') {
    try {
      const { postId, user_id } = await c.req.json();

      if (!user_id || !postId) {
        return c.json({ success: false, error: 'Missing required parameters: user_id or postId' }, 400);
      }

      // Remove from HPYHN_DONTMISS_POSTS
      const existingDontMissPosts = await env.HPYHN_DONTMISS_POSTS.get(user_id);
      let dontMissPosts: any[] = existingDontMissPosts ? JSON.parse(existingDontMissPosts) : [];
      const initialLengthPosts = dontMissPosts.length;
      dontMissPosts = dontMissPosts.filter(post => post.id !== postId);

      if (dontMissPosts.length < initialLengthPosts) {
        await env.HPYHN_DONTMISS_POSTS.put(user_id, JSON.stringify(dontMissPosts));
        console.log(`Removed post ${postId} for user ${user_id} from HPYHN_DONTMISS_POSTS`);
      } else {
        console.log(`Post ${postId} not found for user ${user_id} in HPYHN_DONTMISS_POSTS`);
      }


      // Remove from HPYHN_INTERESTS_SCORE 'dont-miss' array
      const existingInterestScoreData = await env.HPYHN_INTERESTS_SCORE.get(user_id);
      let userInterestScores: { [key: string]: any[] } = existingInterestScoreData ? JSON.parse(existingInterestScoreData) : {};

      let existingDontMiss = userInterestScores['dont-miss'] || [];
      const initialLengthInterest = existingDontMiss.length;
      existingDontMiss = existingDontMiss.filter(item => item.id !== postId);

      if (existingDontMiss.length < initialLengthInterest) {
        userInterestScores['dont-miss'] = existingDontMiss;
        await env.HPYHN_INTERESTS_SCORE.put(user_id, JSON.stringify(userInterestScores));
        console.log(`Removed post ${postId} for user ${user_id} from HPYHN_INTERESTS_SCORE 'dont-miss'`);
      } else {
        console.log(`Post ${postId} not found for user ${user_id} in HPYHN_INTERESTS_SCORE 'dont-miss'`);
      }

      if (dontMissPosts.length < initialLengthPosts || existingDontMiss.length < initialLengthInterest) {
        return c.json({ success: true, message: `Post ${postId} deleted successfully for user ${user_id}` });
      } else {
        return c.json({ success: false, message: `Post ${postId} not found for user ${user_id} in either cache.` }, 404);
      }

    } catch (error) {
      console.error('Error in dont_miss DELETE:', error);
      return c.json({ success: false, error: 'Failed to delete dont-miss post', details: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  }

  return c.json({ success: false, error: 'Method Not Allowed' }, 405);
};