import { Context } from 'hono';

const VALID_TYPES = [
  'news',
  'ask',
  'show',
  'front-page',
  'favorites',
  'dont-miss'
];

/**
 * GET /api/posts?type=xxx
 * 从KV缓存获取对应type的数据
 */
export const getPostsHandler = async (c: Context) => {
  try {
    const type = c.req.query('type');
    const user_id = c.req.query('user_id');

    if (!type || !VALID_TYPES.includes(type)) {
      return c.json({
        error: 'Invalid type',
        message: `type参数必须为: ${VALID_TYPES.join(', ')}`
      }, 400);
    }

    // favorites和dont-miss类型需要user_id参数
    if ((type === 'favorites' || type === 'dont-miss') && !user_id) {
      return c.json({
        error: 'Missing parameter',
        message: `${type}类型必须提供user_id参数`
      }, 400);
    }

    // 处理favorites类型
    if (type === 'favorites') {
      const favoritesList = await getFavoritesPosts(c, user_id!);
      const filteredFavoritesList = await checkSubscriptionAndFilterPosts(c, user_id!, favoritesList);
      return c.json(filteredFavoritesList);
    }

    // 处理dont-miss类型
    if (type === 'dont-miss') {
      const dontMissKv = c.env?.HPYHN_DONTMISS_POSTS;
      if (!dontMissKv) {
        return c.json({
          error: 'KV not configured',
          message: '未找到HPYHN_DONTMISS_POSTS KV命名空间'
        }, 500);
      }
      const kvValue = await dontMissKv.get(user_id!);
      if (!kvValue) {
        return c.json([]);
      }
      // For 'dont-miss' type, apply the subscription filter if user_id is present
      const posts = JSON.parse(kvValue);
      const filteredPosts = await checkSubscriptionAndFilterPosts(c, user_id!, posts);
      return c.json(filteredPosts);
    }

    // 其他类型使用HPYHN_KV
    const kv = c.env?.HPYHN_KV;
    if (!kv) {
      return c.json({
        error: 'KV not configured',
        message: '未找到KV命名空间'
      }, 500);
    }

    // 从KV获取数据
    const kvValue = await kv.get(type);
    if (!kvValue) {
      return c.json([]);
    }

    const posts = JSON.parse(kvValue);
    const filteredPosts = await checkSubscriptionAndFilterPosts(c, user_id, posts);
    return c.json(filteredPosts);
  } catch (error) {
    console.error('Error in getPostsHandler:', error);
    return c.json({
      error: 'Internal Server Error',
      message: '获取数据时发生错误'
    }, 500);
  }
};

/**
 * 获取用户收藏的帖子列表（包含详细信息）
 * 1. 先从HPYHN_FAVORITES_POSTS缓存获取
 * 2. 如果缓存不存在，从Supabase获取基础数据（已同步的喜欢）
 * 3. 合并HPYHN_INTERESTS中的待同步变更
 * 4. 补充新收藏帖子的详细信息
 */
async function getFavoritesPosts(c: Context, user_id: string) {
  const favoritesKv = c.env?.HPYHN_FAVORITES_POSTS;
  const interestsKv = c.env?.HPYHN_INTERESTS;
  if (!favoritesKv || !interestsKv) {
    throw new Error('KV namespaces not configured');
  }

  // 1. 尝试从缓存获取（但不直接返回，需要与待同步变更合并）
  const cached = await favoritesKv.get(user_id);
  let baseFavorites = cached ? JSON.parse(cached) : await fetchBaseFavoritesFromSupabase(c, user_id);
  //console.log(`baseFavorites=${JSON.stringify(baseFavorites)}`)
  // 2. 获取待同步的变更（HPYHN_INTERESTS中的临时数据）
  const pendingChanges = await fetchPendingChanges(interestsKv, user_id);

  // 3. 创建收藏帖子的Map (hn_id -> post details)
  const favoritesMap = new Map<number, any>();
  baseFavorites.forEach((post: any) => {
    favoritesMap.set(post.id, post);
  });
  console.log(`change=${JSON.stringify(pendingChanges)}`)
  // 4. 处理待同步变更
  for (const change of pendingChanges) {
    if (change.interest === 'like') {
      // 如果是新的喜欢，且不在当前收藏中，获取详细信息
      if (!favoritesMap.has(change.postId)) {
        const postDetails = await fetchPostDetails(c, change.postId);
        if (postDetails) {
          favoritesMap.set(change.postId, postDetails);
        }
      }
    } else {
      // 取消喜欢则从收藏中移除
      favoritesMap.delete(change.postId);
    }
  }

  // 5. 生成最终结果并更新缓存（如果与缓存不一致）
  const favoritesList = Array.from(favoritesMap.values());
  if (!cached || JSON.stringify(favoritesList) !== JSON.stringify(baseFavorites)) {
    await favoritesKv.put(user_id, JSON.stringify(favoritesList));
  }

  return favoritesList;
}

/**
 * 从Supabase获取基础收藏数据（已同步的喜欢，包含帖子详细信息）
 */
async function fetchBaseFavoritesFromSupabase(c: Context, user_id: string) {
  const env = c.env as any;
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase environment variables not configured');
    return [];
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_post_interests?user_id=eq.${user_id}&interest_type=eq.like&select=hn_posts(id, hn_id, title, url, points, created_at, descendants, user_id, text, content_summary)`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase request failed: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json();
    // 提取hn_posts数据并过滤空值
    return data
      .map((item: any) => item.hn_posts)
      .filter((post: any) => post);
  } catch (error) {
    console.error('Error fetching from Supabase:', error);
    return [];
  }
}

/**
 * 获取单个帖子的详细信息
 */
async function fetchPostDetails(c: Context, id: number) {
  const env = c.env as any;
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase environment variables not configured');
    return null;
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/hn_posts?id=eq.${id}&select=id, hn_id, title, url, points, created_at, descendants, user_id, text, content_summary`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase post details request failed: ${response.status} ${errorText}`);
      return null;
    }

    const data = await response.json();
    return data[0] || null;
  } catch (error) {
    console.error('Error fetching post details:', error);
    return null;
  }
}

async function fetchPendingChanges(interestsKv: any, user_id: string) {
  try {
    const existing = await interestsKv.get(user_id);
    if (existing) {
      return JSON.parse(existing);
    }
  } catch (error) {
    console.error('Error fetching pending changes:', error);
  }
  return [];
}

/**
 * 检查用户订阅状态并根据订阅情况过滤帖子列表。
 * 对于无订阅或订阅已过期的用户，只保留前三个帖子的 content_summary 字段，
 * 其余帖子的 content_summary 字段设置为 null。
 */
async function checkSubscriptionAndFilterPosts(c: Context, user_id: string | undefined, posts: any[]) {
  // If no user_id is provided, treat as not subscribed and apply filtering
  if (!user_id) {
    return posts.map((post, index) => {
      if (index >= 30) {
        return { ...post, summary_comments: [] };
      }
      return post;
    });
  }

  const env = c.env as any;
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase environment variables not configured for subscription check');
    return posts; // Return original posts if Supabase is not configured
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/subscriptions?user_id=eq.${user_id}&select=status,current_period_end`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Supabase subscription request failed: ${response.status} ${errorText}`);
      return posts; // Return original posts on error
    }

    const data = await response.json();
    const subscription = data[0]; // Assuming one subscription per user

    const now = new Date();
    let isSubscribed = false;

    if (subscription && subscription.status === 'active' && new Date(subscription.current_period_end) > now) {
      isSubscribed = true;
    }

    if (!isSubscribed) {
      // User is not subscribed or subscription expired, filter summary_comments
      return posts.map((post, index) => {
        if (index >= 30) {
          return { ...post, summary_comments: [] };
        }
        return post;
      });
    }

    return posts; // Return original posts if subscribed
  } catch (error) {
    console.error('Error checking subscription:', error);
    return posts; // Return original posts on error
  }
}