import { Router } from 'express';
import healthRoutes from './health.js';
import qbittorrentRoutes from './qbittorrent.js';
import pipelineRoutes from './pipeline.js';
import searchRoutes from './search.js';
import libraryRoutes from './library.js';
import mediaRoutes from './media.js';
import slskdRoutes from './slskd.js';
import activityRoutes from './activity.js';
import installerRoutes from './installer.js';

const router = Router();

// Child routers own their concrete paths; this file just composes the API surface.
router.use(healthRoutes);
router.use(qbittorrentRoutes);
router.use(pipelineRoutes);
router.use(searchRoutes);
router.use(libraryRoutes);
router.use(mediaRoutes);
router.use(slskdRoutes);
router.use(activityRoutes);
router.use(installerRoutes);

export default router;
