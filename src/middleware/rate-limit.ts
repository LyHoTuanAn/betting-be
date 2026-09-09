import type {NextFunction,Request,Response} from 'express';
import {AppError} from '../lib/http.js';

const buckets=new Map<string,{count:number;resetAt:number}>();
export const rateLimit=(limit:number,windowMs:number)=>(req:Request,_res:Response,next:NextFunction)=>{
 const now=Date.now(),key=`${req.ip}:${req.path}`,bucket=buckets.get(key);
 if(!bucket||bucket.resetAt<=now){buckets.set(key,{count:1,resetAt:now+windowMs});return next()}
 if(bucket.count>=limit)return next(new AppError(429,'Bạn thao tác quá nhanh, vui lòng thử lại','RATE_LIMITED'));
 bucket.count++;next();
};
