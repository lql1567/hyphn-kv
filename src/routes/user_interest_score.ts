import { Context } from 'hono';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@aws-sdk/signature-v4';


export const user_interest_score = async (c: Context) => {
  const { user_id, postType } = c.req.query();
  
  if (!user_id || !postType) {
    return c.json({ success: false, error: 'Missing required parameters: user_id and postType' }, 400);
  }
  
  const env = c.env as any;
  
  try {
    // 从 HPYHN_INTERESTS_SCORE 获取用户数据
    const userData = await env.HPYHN_INTERESTS_SCORE.get(user_id);
    
    if (userData) {
      // 解析 JSON 数据
      const userInterests = JSON.parse(userData);
      
      // 获取指定 postType 的值
      const interestScore = userInterests[postType] || [];
      
      return c.json(
        interestScore
      );
    } else {
      // 如果没有找到用户数据，调用 AWS Lambda
      console.log(`User ${user_id} not found in KV, calling AWS Lambda`);
      
      try {
        await invokeAwsLambda(c, user_id, postType);
        
        // 返回空数组
        return c.json([]);
      } catch (lambdaError) {
        console.error(`Error calling AWS Lambda for user ${user_id}:`, lambdaError);
        return c.json({ 
          success: true, 
          data: [],
          user_id: user_id,
          postType: postType,
          message: 'User data not found, AWS Lambda call failed, returning empty array'
        });
      }
    }
  } catch (error) {
    console.error(`Error processing user-interest-score for user ${user_id}:`, error);
    return c.json({ 
      success: false, 
      error: 'Failed to process request',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
};

export const update_user_interest_score = async (c: Context) => {
  const { user_id, postType, interestScore } = await c.req.json();

  if (!user_id || !postType || !interestScore) {
    return c.json({ success: false, error: 'Missing required parameters: user_id, postType, or interestScore' }, 400);
  }

  const env = c.env as any;

  try {
    // 从 KV 获取现有用户数据
    const existingData = await env.HPYHN_INTERESTS_SCORE.get(user_id);
    let userInterests = existingData ? JSON.parse(existingData) : {};

    // 更新或覆盖指定 postType 的值
    userInterests[postType] = interestScore;

    // 将更新后的数据写回 KV
    await env.HPYHN_INTERESTS_SCORE.put(user_id, JSON.stringify(userInterests));

    return c.json({ 
      success: true, 
      message: 'Interest score updated successfully',
      user_id,
      postType,
      interestScore
    });
  } catch (error) {
    console.error(`Error updating interest score for user ${user_id}:`, error);
    return c.json({ 
      success: false, 
      error: 'Failed to update interest score',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
};

// 调用AWS Lambda函数
async function invokeAwsLambda(c: Context, user_id: string, postType: string) {
  try {
    const env = c.env as any;
    const lambdaUrl = env.AWS_LAMBDA_SCORE_URL;
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
    const requestBody = JSON.stringify({ "user_id": user_id, "postType": postType });
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
      console.log(`Successfully invoked AWS Lambda for user ${user_id} with postType ${postType}`);
    }
  } catch (error) {
    console.error(`Error invoking AWS Lambda for user ${user_id} with postType ${postType}:`, error);
    throw error; // Re-throw the error to be caught by the caller
  }
}
