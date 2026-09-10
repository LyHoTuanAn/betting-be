import type {NextFunction,Request,Response} from 'express';
import {AppError} from '../lib/http.js';

const buckets=new Map<string,{count:number;resetAt:number}>();

/**
 * Khi chặn, phải nói rõ còn bao lâu nữa mới thao tác lại được — trước đây client
 * chỉ nhận "thử lại" nên người dùng bấm liên tục và tự kéo dài thời gian chờ.
 */
export const rateLimit=(limit:number,windowMs:number)=>(req:Request,res:Response,next:NextFunction)=>{
 const now=Date.now(),key=`${req.ip}:${req.path}`,bucket=buckets.get(key);
 if(!bucket||bucket.resetAt<=now){buckets.set(key,{count:1,resetAt:now+windowMs});return next()}
 if(bucket.count>=limit){
  const retryAfter=Math.max(1,Math.ceil((bucket.resetAt-now)/1000));
  res.setHeader('Retry-After',retryAfter);
  return next(new AppError(429,`Bạn thao tác quá nhanh (tối đa ${limit} lần/${Math.round(windowMs/1000)} giây). Vui lòng thử lại sau ${retryAfter} giây.`,'RATE_LIMITED',{retryAfter,limit,windowSeconds:Math.round(windowMs/1000)}));
 }
 bucket.count++;next();
};
