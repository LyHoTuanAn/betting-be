import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {config} from './config.js';
import {errorHandler,requestId,AppError} from './lib/http.js';
import {requireAdmin,requireAuth} from './middleware/auth.js';
import {rateLimit} from './middleware/rate-limit.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import gameRoutes from './routes/game.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import adminRoutes from './routes/admin.routes.js';
import contentRoutes from './routes/content.routes.js';

export function createApp(){
 const app=express();app.set('trust proxy',1);app.disable('x-powered-by');app.use(requestId);
 app.use(helmet());app.use(cors({origin:config.FRONTEND_ORIGIN,credentials:false}));app.use(express.json({limit:'100kb'}));
 app.get('/',(_req,res)=>res.json({status:'online',service:'GoldZone API',version:'2.0.0',health:'/api/health'}));
 app.get('/api/health',(_req,res)=>res.json({status:'ok',time:new Date().toISOString()}));
 app.use('/api/auth',rateLimit(20,60_000),authRoutes);
 app.use('/api/content',rateLimit(120,60_000),contentRoutes);
 app.use('/api',userRoutes);
 app.use('/api/games',requireAuth,rateLimit(300,60_000),gameRoutes);
 app.use('/api/wallet',requireAuth,rateLimit(60,60_000),walletRoutes);
 app.use('/api/admin',requireAuth,requireAdmin,adminRoutes);
 app.use((req,_res,next)=>next(new AppError(404,`Không tìm thấy API ${req.method} ${req.path}`,'NOT_FOUND')));app.use(errorHandler);return app;
}
