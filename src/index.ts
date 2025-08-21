import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getPostsHandler } from './routes/posts';
import { user_interest } from './routes/user_interest';
import { user_interest_score, update_user_interest_score } from './routes/user_interest_score';

// Cloudflare KV 命名空间类型定义
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string, options?: { type: 'text' | 'json' | 'arrayBuffer' }): Promise<any>;
  put(key: string, value: string | ReadableStream, options?: { expiration?: number; expirationTtl?: number; metadata?: any }): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string; expiration?: number; metadata?: any }>; list_complete: boolean; cursor?: string }>;
}

interface Env {
  HPYHN_KV: KVNamespace;
  HPYHN_INTERESTS: KVNamespace;
  HPYHN_INTERESTS_SCORE: KVNamespace;
  REFRESH_KV_TOKEN: string; // 添加 token 环境变量
  VERCEL_URL: string; // 添加 Vercel URL 环境变量
  SUPABASE_URL: string; // Supabase URL
  SUPABASE_SERVICE_ROLE_KEY: string; // Supabase service role key
  CRON_SECRET: string; // 添加 Cron 密钥环境变量
  // 其他环境变量
}

// Cloudflare Worker 定时任务事件类型定义
interface ScheduledEvent {
  scheduledTime: number;
}

// Cloudflare Worker 执行上下文类型定义
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

// 创建应用实例
const app = new Hono();

// 配置 CORS 中间件
const corsMiddleware = cors({
  origin: ['http://localhost:3000', 'https://hpyhn.vercel.app'], // 替换为你的前端域名
  credentials: true,
});

// 应用 CORS 中间件到所有路由
app.use('*', corsMiddleware);

// Token 校验中间件
const tokenAuthMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.split(' ')[1]; // 假设格式为 "Bearer <token>"
  console.log('Token received:', token); // 添加日志跟踪
  
  // 从环境变量中获取有效的 token
  const env = c.env as Env;
  const validToken = env.REFRESH_KV_TOKEN; // 你需要在环境变量中设置这个值
  
  if (!token || token !== validToken) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  
  await next();
};

// 注册API路由
app.get('/api/posts', getPostsHandler);
app.get('/api/user-interests', user_interest);
app.post('/api/user-interests', user_interest);
app.get('/api/user-interest-score', user_interest_score);
app.post('/api/update_user_interest_score', tokenAuthMiddleware, update_user_interest_score);

// 为 /api/refresh-kv 路由应用 token 校验中间件
app.get('/api/refresh-kv', tokenAuthMiddleware, async (c) => {
  const env = c.env as Env;
  try {
    await refreshKvFromDb(env);
    return c.json({ success: true, message: 'KV cache refreshed successfully' });
  } catch (error) {
    console.error('Error refreshing KV cache:', error);
    return c.json({ success: false, error: 'Failed to refresh KV cache' }, 500);
  }
});

// 为 /api/sync-kv-to-db 路由应用 token 校验中间件
app.get('/api/sync-kv-to-db', tokenAuthMiddleware, async (c) => {
  const env = c.env as Env;
  try {
    await writeKvToDb(env);
    return c.json({ success: true, message: 'KV synced to database successfully' });
  } catch (error) {
    console.error('Error syncing KV to database:', error);
    return c.json({ success: false, error: 'Failed to sync KV to database' }, 500);
  }
});

// 为 /api/sync-hackernews-to-db 路由应用 token 校验中间件
app.get('/api/sync-hackernews-to-db', tokenAuthMiddleware, async (c) => {
  const env = c.env as Env;
  try {
    await syncHackerNewsToDb(env);
    return c.json({ success: true, message: 'HackerNews synced to database successfully' });
  } catch (error) {
    console.error('Error syncing HackerNews to database:', error);
    return c.json({ success: false, error: 'Failed to sync HackerNews to database' }, 500);
  }
});

// 基础路由
app.get('/', (c) => {
  return c.json({ 
    message: 'Welcome to Hyphn-KV API',
    timestamp: new Date().toISOString()
  });
});

export default {
    fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const minute = new Date(event.scheduledTime).getMinutes();
    console.log(`Running scheduled task at ${event.scheduledTime} (minute: ${minute})`);
    if (minute === 0) {
      // 定时将 KV 缓存写入数据库
      await writeKvToDb(env);
    }
    if (minute % 30 === 0) {
      // 定时从数据库刷数据到 KV 缓存
      await refreshKvFromDb(env);
    }
    if (minute % 20 === 0) {
      // 定时从hackernews同步数据到数据库
      await syncHackerNewsToDb(env);
    }
  },
};

// 批量删除兴趣记录
async function batchDeleteInterestFromSupabase(env: Env, deleteBatch: Array<{ user_id: string, post_id: number }>) {
  if (deleteBatch.length === 0) return;
  
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase environment variables not configured');
  }
  
  // 构建批量删除的过滤条件
  const filters = deleteBatch.map(item => `user_id=eq.${item.user_id};post_id=eq.${item.post_id}`).join(',');
  
  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_post_interests?or=(${filters})`,
    {
      method: 'DELETE',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to batch delete interests: ${response.status} ${errorText}`);
  }
  
  console.log(`Batch deleted ${deleteBatch.length} interests`);
}

// 批量插入或更新兴趣记录
async function batchUpsertInterestToSupabase(env: Env, upsertBatch: Array<{ user_id: string, post_id: number, interest_type: string }>) {
  if (upsertBatch.length === 0) return;
  
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase environment variables not configured');
  }
  
  // 使用 upsert 功能，通过设置 on_conflict 参数处理主键冲突
  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_post_interests?on_conflict=user_id,post_id`,
    {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates', // 允许更新重复项
      },
      body: JSON.stringify(upsertBatch),
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to batch upsert interests: ${response.status} ${errorText}`);
  }
  
  console.log(`Batch upserted ${upsertBatch.length} interests`);
}

async function writeKvToDb(env: Env) {
  try {
    const kv = env.HPYHN_INTERESTS;
    const keyList = await kv.list();
    const keys = keyList.keys;
    
    console.log(`Found ${keys.length} users in KV`);
    
    // 批量操作数组
    const deleteBatch: Array<{ user_id: string, post_id: number }> = [];
    const upsertBatch: Array<{ user_id: string, post_id: number, interest_type: string }> = [];
    
    // 遍历每个用户
    for (const key of keys) {
      const user_id = key.name;
      console.log(`Processing user: ${user_id}`);
      
      const value = await kv.get(user_id);
      if (!value) {
        console.log(`No data found for user: ${user_id}`);
        continue;
      }
      
      let interests: Array<{ postId: number, interest: string | null }> = [];
      try {
        interests = JSON.parse(value);
      } catch (error) {
        console.error(`Failed to parse interests for user ${user_id}:`, error);
        continue;
      }
      
      console.log(`Found ${interests.length} interests for user: ${user_id}`);
      
      // 处理每个兴趣项
      for (const item of interests) {
        try {
          // 如果 interest 为 null，则添加到删除批次
          if (item.interest === null) {
            deleteBatch.push({ user_id, post_id: item.postId });
          } else {
            // 否则添加到插入/更新批次
            upsertBatch.push({ user_id, post_id: item.postId, interest_type: item.interest });
          }
          
          // 当批次达到15条时，执行批量操作
          if (deleteBatch.length >= 15) {
            await batchDeleteInterestFromSupabase(env, deleteBatch);
            deleteBatch.length = 0; // 清空批次
          }
          
          if (upsertBatch.length >= 15) {
            await batchUpsertInterestToSupabase(env, upsertBatch);
            upsertBatch.length = 0; // 清空批次
          }
        } catch (error) {
          console.error(`Failed to process interest for user ${user_id}, postId ${item.postId}:`, error);
        }
      }
    }
    
    // 处理剩余的批次数据
    if (deleteBatch.length > 0) {
      await batchDeleteInterestFromSupabase(env, deleteBatch);
    }
    
    if (upsertBatch.length > 0) {
      await batchUpsertInterestToSupabase(env, upsertBatch);
    }
    
    console.log('Successfully synced KV to Supabase with batch operations');
  } catch (error) {
    console.error('Error in writeKvToDb:', error);
    throw error;
  }
}


// 刷新 KV 缓存
async function refreshKvFromDb(env: Env) {
  const types = ['ask', 'front-page', 'news', 'show'];
  for (const type of types) {
    try {
      const postsUrl = `${env.VERCEL_URL}/api/posts?type=${type}`;
      console.log(`Fetching posts from: ${postsUrl}`);
      
      const postsResponse = await fetch(postsUrl);
      if (!postsResponse.ok) {
        console.error(`Failed to fetch posts for type ${type}:`, postsResponse.statusText);
        continue;
      }
      
      const postsData = await postsResponse.json();
      console.log(`Fetched ${Array.isArray(postsData) ? postsData.length : 'unknown'} ${type} posts`);
      
      // 将 posts 数据存入 KV，type 作为 key
      await env.HPYHN_KV.put(`${type}`, JSON.stringify(postsData));
      console.log(`Stored posts for type ${type} in KV with key '${type}'`);

      // 清空 HPYHN_INTERESTS_SCORE KV
      try {
        const scoreKv = env.HPYHN_INTERESTS_SCORE;
        const keyList = await scoreKv.list();
        const keys = keyList.keys;
        console.log(`Found ${keys.length} keys in HPYHN_INTERESTS_SCORE to delete`);

        // 批量删除所有键
        for (const key of keys) {
          await scoreKv.delete(key.name);
        }

        console.log('Successfully cleared HPYHN_INTERESTS_SCORE KV');
      } catch (error) {
        console.error('Error clearing HPYHN_INTERESTS_SCORE KV:', error);
      }
    } catch (error) {
      console.error(`Error fetching/storing posts for type ${type}:`, error);
    }
  }
}

async function syncHackerNewsToDb(env: Env) {
  try {
    const types = ['ask', 'front-page', 'news', 'show'];
    for (const type of types) {
      const url = `${env.VERCEL_URL}/api/sync-${type}`;
      console.log(`Fetching posts for type: ${type} from: ${url}`); // 添加日志跟踪
      
      // 添加 token 授权头
      const headers = {
        'Authorization': `Bearer ${env.CRON_SECRET}`
      };
      
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        console.error(`Failed to fetch posts for type ${type}:`, resp.statusText);
        continue;
      }

      // First get the response as text to see what we're dealing with
      const textData = await resp.text();
      console.log(`Raw response for type ${type}:`, 
                    textData.substring(0, 100) + '...'); // Log first 100 chars
      // 解析 JSON 数据
      try {
        const jsonData = JSON.parse(textData);
        console.log(`Extracted value for type ${jsonData.type}:`, jsonData.count ? `${jsonData.count} items` : '0 items');
      } catch (error) {
        console.error(`Failed to parse JSON for type ${type}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in syncHackerNewsToDb:', error);
  }
}