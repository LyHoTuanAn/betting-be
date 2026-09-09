import type {NextFunction, Request, Response} from 'express';
import jwt from 'jsonwebtoken';
import type {Role} from '@prisma/client';
import {config} from '../config.js';
import {AppError} from '../lib/http.js';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return next(new AppError(401,'Bạn cần đăng nhập','AUTH_REQUIRED'));
  try {
    const payload = jwt.verify(token,config.JWT_ACCESS_SECRET,{issuer:'goldzone-api',audience:'goldzone-web'}) as jwt.JwtPayload;
    req.auth = {userId:String(payload.sub),role:payload.role as Role}; next();
  } catch { next(new AppError(401,'Access token không hợp lệ hoặc hết hạn','INVALID_ACCESS_TOKEN')); }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.role !== 'ADMIN') return next(new AppError(403,'Bạn không có quyền quản trị','ADMIN_REQUIRED'));
  next();
}
