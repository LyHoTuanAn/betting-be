import {Router} from 'express';
import {asyncRoute, jsonSafe} from '../lib/http.js';
import {getPublicBanners, getPublicEvents} from '../services/content.service.js';

const router = Router();

router.get('/banners', asyncRoute(async (_req, res) => {
  const items = await getPublicBanners();
  res.json({banners: jsonSafe(items)});
}));

router.get('/events', asyncRoute(async (_req, res) => {
  const items = await getPublicEvents();
  res.json({events: jsonSafe(items)});
}));

export default router;
