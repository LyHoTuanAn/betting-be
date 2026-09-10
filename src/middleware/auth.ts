import type {NextFunction, Request, Response} from 'express';
import jwt from 'jsonwebtoken';
import type {Role} from '@prisma/client';
import {config} from '../config.js';
import {AppError} from '../lib/http.js';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  if (!header) return next(new AppError(401,'Bạn cần đăng nhập để dùng chức năng này','AUTH_REQUIRED'));
  const token = header.match(/^Bearer (.+)$/i)?.[1];
  // Sai định dạng header là lỗi phía client gọi API, khác hẳn token hết hạn;
  // gộp chung một câu khiến người tích hợp đi sửa nhầm chỗ.
  if (!token) return next(new AppError(401,'Header Authorization phải có dạng "Bearer <access token>"','MALFORMED_AUTH_HEADER'));
  try {
    const payload = jwt.verify(token,config.JWT_ACCESS_SECRET,{issuer:'goldzone-api',audience:'goldzone-web'}) as jwt.JwtPayload;
    req.auth = {userId:String(payload.sub),role:payload.role as Role}; next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) return next(new AppError(401,'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại','ACCESS_TOKEN_EXPIRED'));
    next(new AppError(401,'Access token không hợp lệ, vui lòng đăng nhập lại','INVALID_ACCESS_TOKEN'));
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new AppError(401,'Bạn cần đăng nhập để dùng chức năng này','AUTH_REQUIRED'));
  if (req.auth.role !== 'ADMIN') return next(new AppError(403,'Tài khoản của bạn không có quyền quản trị','ADMIN_REQUIRED'));
  next();
}
