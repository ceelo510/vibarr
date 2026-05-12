import { Router } from 'express';
import { getActivityLog } from '../state.js';

const router = Router();

router.get('/activity-log', (req, res) => {
  const activityLog = getActivityLog();
  const since = req.query.since;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  let entries = activityLog;
  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      entries = entries.filter(e => new Date(e.timestamp) > sinceDate);
    }
  }
  // Polling clients only need summary rows here; detailed steps stay on the per-entry route.
  const slim = entries.slice(0, limit).map(e => ({
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
  res.json({ success: true });
});

router.delete('/activity-log/:id', (req, res) => {
  const activityLog = getActivityLog();
  const idx = activityLog.findIndex(e => e.id === req.params.id);
  if (idx >= 0) activityLog.splice(idx, 1);
  res.json({ success: true });
});

export default router;
