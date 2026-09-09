import {createHash, randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt, {type SignOptions} from 'jsonwebtoken';
import type {Request} from 'express';
import {Prisma} from '@prisma/client';
import {prisma} from '../lib/prisma.js';
import {config} from '../config.js';
import {AppError} from '../lib/http.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const publicUser = (user: {id:string;username:string;displayName:string;balance:bigint;role:string;createdAt:Date}) => ({id:user.id,username:user.username,displayName:user.displayName,balance:Number(user.balance),role:user.role,createdAt:user.createdAt});

function accessToken(user: {id: string; role: string}) {
  return jwt.sign({sub:user.id, role:user.role}, config.JWT_ACCESS_SECRET, {expiresIn: config.ACCESS_TOKEN_TTL as SignOptions['expiresIn'], issuer:'goldzone-api', audience:'goldzone-web'});
}

async function issueSession(user: {id:string;role:string}, req: Request) {
  const refreshToken = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000);
  await prisma.session.create({data:{userId:user.id,refreshTokenHash:hashToken(refreshToken),expiresAt,userAgent:req.get('user-agent')?.slice(0,500),ipAddress:req.ip}});
  return {token:accessToken(user),refreshToken,expiresAt};
}

export async function register(input: {username:string;displayName:string;password:string}, req: Request) {
  const exists = await prisma.user.findUnique({where:{username:input.username}});
  if (exists) throw new AppError(409, 'Tên đăng nhập đã tồn tại', 'USERNAME_EXISTS');
  const passwordHash = await bcrypt.hash(input.password, 12);
  let user;
  try{user = await prisma.$transaction(async tx => {
    const created = await tx.user.create({data:{username:input.username,displayName:input.displayName,passwordHash}});
    await tx.walletLedger.create({data:{userId:created.id,type:'WELCOME_BONUS',amount:created.balance,balanceAfter:created.balance,description:'Quà chào mừng thành viên mới: 50.000 vàng'}});
    return created;
  });}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new AppError(409,'Tên đăng nhập đã tồn tại','USERNAME_EXISTS');throw error}
  return {...await issueSession(user,req),user:publicUser(user)};
}

export async function login(input: {username:string;password:string}, req: Request) {
  const user = await prisma.user.findUnique({where:{username:input.username}});
  if (!user || !(await bcrypt.compare(input.password,user.passwordHash))) throw new AppError(401,'Tên đăng nhập hoặc mật khẩu không đúng','INVALID_CREDENTIALS');
  if (user.status !== 'ACTIVE') throw new AppError(403,'Tài khoản đang bị khóa','ACCOUNT_SUSPENDED');
  return {...await issueSession(user,req),user:publicUser(user)};
}

export async function refresh(rawToken: string, req: Request) {
  const session = await prisma.session.findUnique({where:{refreshTokenHash:hashToken(rawToken)},include:{user:true}});
  if (!session || session.revokedAt || session.expiresAt <= new Date()) throw new AppError(401,'Refresh token không hợp lệ','INVALID_REFRESH_TOKEN');
  const revoked=await prisma.session.updateMany({where:{id:session.id,revokedAt:null},data:{revokedAt:new Date()}});
  if(!revoked.count)throw new AppError(401,'Refresh token đã được sử dụng','INVALID_REFRESH_TOKEN');
  if (session.user.status !== 'ACTIVE') throw new AppError(403,'Tài khoản đang bị khóa','ACCOUNT_SUSPENDED');
  return {...await issueSession(session.user,req),user:publicUser(session.user)};
}

export async function logout(rawToken: string) {
  await prisma.session.updateMany({where:{refreshTokenHash:hashToken(rawToken),revokedAt:null},data:{revokedAt:new Date()}});
}
