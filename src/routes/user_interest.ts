import { Context } from 'hono';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@aws-sdk/signature-v4';

/**
 * 用户兴趣接口处理函数
 * 路径: GET /api/user-interests?user_id=xxx
 * 路径: POST /api/user-interests
 * POST body: { user_id: string, postId: number, interest: string | null }
 */
export const user_interest = async (c: Context) => {
  if (c.req.method === 'POST') {
    // 处理POST请求
    try {
      const body = await c.req.json<{ user_id: string, postId: number, interest: string | null }>();
      console.log('Request body:', body);
      const { user_id, postId, interest } = body;

      if (!user_id || !postId || interest === undefined) {
        return c.json({
          error: 'Missing parameters',
          message: 'user_id, postId, interest 必须全部提供'
        }, 400);
      }

      const kv = c.env?.HPYHN_INTERESTS;
      if (!kv) {
        return c.json({
          error: 'KV not configured',
          message: '未找到HPYHN_INTERESTS命名空间'
        }, 500);
      }

      // 先读取已有数据
      const existing = await kv.get(user_id);
      let interests: Array<{ postId: number, interest: string | null }> = [];
      if (existing) {
        try {
          interests = JSON.parse(existing);
        } catch {
          interests = [];
        }
      }

      // 更新或添加
      const idx = interests.findIndex(item => item.postId === postId);
      if (idx >= 0) {
        interests[idx].interest = interest;
      } else {
        interests.push({ postId, interest });
      }

      await kv.put(user_id, JSON.stringify(interests));

      // 检查是否需要调用AWS Lambda (只在POST请求中)
      await checkAndInvokeLambda(c, user_id, interests);

      return c.json({
        message: '写入成功',
        user_id,
        postId,
        interest,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error in POST /api/user-interest:', error);
      return c.json({
        error: 'Internal Server Error',
        message: '写入数据时发生错误'
      }, 500);
    }
  } else if (c.req.method === 'GET') {
    // 处理GET请求
    try {
      const user_id = c.req.query('user_id');

      if (!user_id) {
        return c.json({
          error: 'Missing parameters',
          message: 'user_id 必须提供'
        }, 400);
      }

      const kv = c.env?.HPYHN_INTERESTS;
      if (!kv) {
        return c.json({
          error: 'KV not configured',
          message: '未找到HPYHN_INTERESTS命名空间'
        }, 500);
      }

      // 先从KV缓存中查找
      let value = await kv.get(user_id);
      
      // 如果KV中没有找到数据，则从Supabase数据库中获取
      if (!value) {
        console.log(`User ${user_id} not found in KV, fetching from Supabase`);
        const supabaseData = await fetchInterestsFromSupabase(c, user_id);
        
        // 将从数据库获取的数据保存到KV中，以便下次快速访问
        if (supabaseData && supabaseData.length > 0) {
          await kv.put(user_id, JSON.stringify(supabaseData));
          value = JSON.stringify(supabaseData);
        }
      }

      // 如果仍然没有数据，返回404
      if (!value) {
        return c.json({
          error: 'Not found',
          message: '未找到该用户的兴趣数据'
        }, 404);
      }

      let interests: Array<{ postId: number, interest: string | null }> = [];
      try {
        interests = JSON.parse(value);
      } catch {
        interests = [];
      }

      // 转换为 { "postId1": "xxx", "postId2": "yyy" } 格式
      const result: { [key: string]: string | null } = {};
      interests.forEach(item => {
        result[`${item.postId}`] = item.interest;
      });

      // 如果没有兴趣数据，返回404
      if (Object.keys(result).length === 0) {
        return c.json({
          error: 'Not found',
          message: '未找到该用户的兴趣数据'
        }, 404);
      }

      return c.json(result);
    } catch (error) {
      console.error('Error in GET /api/user-interests:', error);
      return c.json({
        error: 'Internal Server Error',
        message: '读取数据时发生错误'
      }, 500);
    }
  } else {
    return c.json({
      error: 'Method Not Allowed',
      message: '只支持GET和POST请求'
    }, 405);
  }
};

// 从Supabase获取用户兴趣数据
async function fetchInterestsFromSupabase(c: Context, user_id: string) {
  try {
    const env = c.env as any;
    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables not configured');
    }
    
    // 从Supabase获取用户兴趣数据
    const response = await fetch(
      `${supabaseUrl}/rest/v1/user_post_interests?user_id=eq.${user_id}&select=*`,
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
      throw new Error(`Failed to fetch from Supabase: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    
    // 转换Supabase数据格式为KV存储格式
    const interests = data.map((item: any) => ({
      postId: item.post_id,
      interest: item.interest_type
    }));
    
    return interests;
  } catch (error) {
    console.error(`Error fetching interests from Supabase for user ${user_id}:`, error);
    return [];
  }
}

// 检查是否需要调用AWS Lambda函数
async function checkAndInvokeLambda(c: Context, user_id: string, interests: Array<{ postId: number, interest: string | null }>) {
  try {
    // 统计like和dislike的数量
    const likeCount = interests.filter(item => item.interest === 'like').length;
    const dislikeCount = interests.filter(item => item.interest === 'dislike').length;

    // 检查是否都大于10
    if (likeCount > 10 && dislikeCount > 10) {
      // 调用AWS Lambda函数
      await invokeAwsLambda(c, user_id);
    }
  } catch (error) {
    console.error('Error checking and invoking Lambda:', error);
  }
}

// 调用AWS Lambda函数
async function invokeAwsLambda(c: Context, user_id: string) {
  try {
    const env = c.env as any;
    const lambdaUrl = env.AWS_LAMBDA_URL;
    const awsAccessKeyId = env.AWS_ACCESS_KEY_ID;
    const awsSecretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    const awsRegion = env.AWS_REGION || 'us-east-1';
    
    if (!lambdaUrl) {
      console.error('AWS Lambda URL not configured');
      return;
    }
    
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      console.error('AWS credentials not configured');
      return;
    }
    
    // 创建SignatureV4实例
    const signer = new SignatureV4({
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
      },
      region: awsRegion,
      service: 'execute-api',
      sha256: Sha256,
    });
    
    // 准备请求体
    const requestBody = JSON.stringify({ "user_id": user_id });
    console.log(`Request Body: ${requestBody}`);
    
    // 准备请求
    const url = new URL(lambdaUrl);
    // 引入 HttpRequest
    // @ts-ignore
    const { HttpRequest } = await import("@aws-sdk/protocol-http");
    const request = new HttpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : undefined,
      method: 'POST',
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        host: url.host,
      },
      body: requestBody,
    });
    
    // 签名请求
    const signedRequest = await signer.sign(request);
    
    // 发送签名后的请求
    // 注意：这里我们使用 signedRequest 中的所有属性，包括 body
    const response = await fetch(lambdaUrl, {
      method: signedRequest.method,
      headers: signedRequest.headers,
      body: requestBody,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to invoke AWS Lambda: ${response.status} ${errorText}`);
    }
    else {
      console.log(`Successfully invoked AWS Lambda for user ${user_id}`);
    }
  } catch (error) {
    console.error(`Error invoking AWS Lambda for user ${user_id}:`, error);
  }
}
