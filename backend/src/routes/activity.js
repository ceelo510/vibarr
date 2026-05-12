import { Router } from 'express';
import { getActivityFeed, getActivityLog, persistActivityLog } from '../state.js';

const router = Router();

router.get('/activity-log', (req, res) => {
  const entries = getActivityFeed({
    since: req.query.since,
    limit: req.query.limit,
    includeHidden: req.query.includeHidden === 'true',
  });
  // Polling clients only need summary rows here; detailed steps stay on the per-entry route.
  const slim = entries.map(e => ({
    ...e,
    stepCount: e.steps?.length || 0,
    steps: undefined,
  }));
  res.json(slim);
});

router.get('/activity-log/:id', (req, res) => {
  const activityLog = getActivityLog();
  const entry = activityLog.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

router.delete('/activity-log', (req, res) => {
  const activityLog = getActivityLog();
  activityLog.length = 0;
  persistActivityLog();
  res.json({ success: true });
});

router.delete('/activity-log/:id', (req, res) => {
  const activityLog = getActivityLog();
  const idx = activityLog.findIndex(e => e.id === req.params.id);
  if (idx >= 0) activityLog.splice(idx, 1);
  persistActivityLog();
  res.json({ success: true });
});

export default router;
