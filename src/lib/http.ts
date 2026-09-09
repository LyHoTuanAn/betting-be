import type {NextFunction, Request, Response} from 'express';
import {ZodError} from 'zod';

export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_ERROR') { super(message); }
}

export const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res)).catch(next);
export const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? Number(item) : item));

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) return res.status(422).json({error: 'Dữ liệu không hợp lệ', code: 'VALIDATION_ERROR', details: error.issues.map(issue => ({path: issue.path.join('.'), message: issue.message}))});
  if (error instanceof AppError) return res.status(error.status).json({error: error.message, code: error.code});
  console.error(error);
  return res.status(500).json({error: 'Lỗi máy chủ', code: 'INTERNAL_ERROR'});
}
