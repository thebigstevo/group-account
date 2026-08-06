'use strict';

const express = require('express');
const dal = require('./dal');
const { validateEventInput, EVENT_LEVELS, EVENT_LEVEL_LABELS } = require('./secretaryDomain');

const router = express.Router();

function allow(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.status(403).render('error', { message: 'You do not have permission for this action.' });
    next();
  };
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getCommanderyId(req) {
  return req.session.user.commandery_id || 1;
}

async function getEventTypes(commanderyId) {
  return dal.query('SELECT * FROM event_types WHERE commandery_id = $1 AND active = true ORDER BY sort_order, name', [commanderyId]);
}

function buildTypeLabels(types) {
  const map = {};
  types.forEach(t => { map[t.slug] = t.name; });
  return map;
}

function googleCalendarUrl(event) {
  const date = new Date(event.meeting_date);
  const dateStr = date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const endDate = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  const endStr = endDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title || 'KSJI Event',
    dates: `${dateStr}/${endStr}`,
    details: '',
    location: event.location || ''
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

router.get('/', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const commanderyId = getCommanderyId(req);
  const year = req.query.year || new Date().getFullYear();
  const eventTypes = await getEventTypes(commanderyId);
  const EVENT_TYPE_LABELS = buildTypeLabels(eventTypes);

  const events = await dal.query(`
    SELECT e.*,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'present')::int AS present_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id)::int AS total_marked
    FROM meetings e
    WHERE e.commandery_id = $1 AND EXTRACT(YEAR FROM e.meeting_date) = $2
    ORDER BY e.meeting_date DESC
  `, [commanderyId, year]);

  const totalEvents = events.length;
  const eventsWithAttendance = events.filter(e => e.total_marked > 0);
  const avgAttendance = eventsWithAttendance.length
    ? Math.round(eventsWithAttendance.reduce((s, e) => s + (e.present_count / e.total_marked * 100), 0) / eventsWithAttendance.length)
    : 0;

  const byLevel = {};
  EVENT_LEVELS.forEach(l => { byLevel[l] = events.filter(e => e.event_level === l).length; });

  const memberScores = await dal.query(`
    SELECT m.id, m.name,
      COUNT(ma.id)::int AS events_tracked,
      COUNT(ma.id) FILTER (WHERE ma.status = 'present')::int AS present_count,
      CASE WHEN COUNT(ma.id) > 0
        THEN ROUND(COUNT(ma.id) FILTER (WHERE ma.status = 'present')::numeric / COUNT(ma.id) * 100)
        ELSE 0 END AS score
    FROM members m
    LEFT JOIN meeting_attendance ma ON ma.member_id = m.id
    LEFT JOIN meetings e ON e.id = ma.meeting_id AND EXTRACT(YEAR FROM e.meeting_date) = $1 AND e.commandery_id = $2
    WHERE m.status = 'active' AND m.commandery_id = $2
    GROUP BY m.id, m.name
    ORDER BY score DESC, m.name
  `, [year, commanderyId]);

  const upcoming = events.filter(e => new Date(e.meeting_date) >= new Date()).reverse().slice(0, 5);

  res.render('secretary/dashboard', {
    events, year, totalEvents, avgAttendance, byLevel, memberScores, upcoming,
    EVENT_LEVEL_LABELS, EVENT_TYPE_LABELS
  });
}));

// ─── Events List ─────────────────────────────────────────────────────────────

router.get('/events', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const commanderyId = getCommanderyId(req);
  const eventTypes = await getEventTypes(commanderyId);
  const EVENT_TYPE_LABELS = buildTypeLabels(eventTypes);

  const events = await dal.query(`
    SELECT e.*,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'present')::int AS present_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'excuse')::int AS excuse_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'absent')::int AS absent_count
    FROM meetings e
    WHERE e.commandery_id = $1
    ORDER BY e.meeting_date DESC
    LIMIT 100
  `, [commanderyId]);
  res.render('secretary/events', { events, EVENT_LEVEL_LABELS, EVENT_TYPE_LABELS });
}));

// ─── Create Event ────────────────────────────────────────────────────────────

router.get('/events/new', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const eventTypes = await getEventTypes(getCommanderyId(req));
  res.render('secretary/event_form', { event: null, errors: [], EVENT_LEVELS, eventTypes, EVENT_LEVEL_LABELS });
}));

router.post('/events', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const commanderyId = getCommanderyId(req);
  const eventTypes = await getEventTypes(commanderyId);
  const errors = validateEventInput(req.body);
  if (errors.length) return res.status(400).render('secretary/event_form', { event: null, errors, values: req.body, EVENT_LEVELS, eventTypes, EVENT_LEVEL_LABELS });

  const result = await dal.run(`
    INSERT INTO meetings (commandery_id, title, meeting_date, event_level, event_type, location, start_time, minutes_url, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [
    commanderyId, req.body.title.trim(), req.body.event_date,
    req.body.event_level, req.body.event_type,
    req.body.location || null, req.body.start_time || null,
    req.body.minutes_url || null, req.session.user.id
  ]);

  await dal.audit(req.session.user.id, 'create', 'event', result.rows[0].id, { title: req.body.title, date: req.body.event_date });
  req.session.flash = { type: 'success', message: 'Event created.' };
  res.redirect(`/secretary/meetings/events/${result.rows[0].id}`);
}));

// ─── Event Detail ────────────────────────────────────────────────────────────

router.get('/events/:id', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const eventTypes = await getEventTypes(getCommanderyId(req));
  const EVENT_TYPE_LABELS = buildTypeLabels(eventTypes);
  const attendance = await dal.query(`
    SELECT ma.*, m.name AS member_name
    FROM meeting_attendance ma JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1 ORDER BY m.name
  `, [event.id]);

  res.render('secretary/event_detail', { event, attendance, googleCalendarUrl: googleCalendarUrl(event), EVENT_LEVEL_LABELS, EVENT_TYPE_LABELS });
}));

// ─── Edit Event ──────────────────────────────────────────────────────────────

router.get('/events/:id/edit', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });
  const eventTypes = await getEventTypes(getCommanderyId(req));
  res.render('secretary/event_form', { event, errors: [], EVENT_LEVELS, eventTypes, EVENT_LEVEL_LABELS });
}));

router.post('/events/:id', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const eventTypes = await getEventTypes(getCommanderyId(req));
  const errors = validateEventInput(req.body);
  if (errors.length) return res.status(400).render('secretary/event_form', { event, errors, values: req.body, EVENT_LEVELS, eventTypes, EVENT_LEVEL_LABELS });

  await dal.run(`
    UPDATE meetings SET
      title = $1, meeting_date = $2, event_level = $3, event_type = $4,
      location = $5, start_time = $6, minutes_url = $7, updated_at = NOW()
    WHERE id = $8
  `, [
    req.body.title.trim(), req.body.event_date,
    req.body.event_level, req.body.event_type,
    req.body.location || null, req.body.start_time || null,
    req.body.minutes_url || null, event.id
  ]);

  await dal.audit(req.session.user.id, 'update', 'event', event.id, { title: req.body.title });
  req.session.flash = { type: 'success', message: 'Event updated.' };
  res.redirect(`/secretary/meetings/events/${event.id}`);
}));

// ─── Delete Event ────────────────────────────────────────────────────────────

router.post('/events/:id/delete', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  await dal.transaction(async (client) => {
    await client.query('DELETE FROM meeting_attendance WHERE meeting_id = $1', [event.id]);
    await client.query('DELETE FROM meetings WHERE id = $1', [event.id]);
  });

  await dal.audit(req.session.user.id, 'delete', 'event', event.id, { title: event.title });
  req.session.flash = { type: 'success', message: 'Event deleted.' };
  res.redirect('/secretary/meetings/events');
}));

// ─── Attendance ──────────────────────────────────────────────────────────────

router.get('/events/:id/attendance', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const members = await dal.query("SELECT id, name FROM members WHERE status = 'active' ORDER BY name");
  const existing = await dal.query('SELECT member_id, status FROM meeting_attendance WHERE meeting_id = $1', [event.id]);
  const attendanceMap = {};
  existing.forEach(r => { attendanceMap[r.member_id] = r.status; });

  res.render('secretary/attendance', { meeting: event, members, attendanceMap });
}));

router.post('/events/:id/attendance', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const members = await dal.query("SELECT id FROM members WHERE status = 'active'");
  await dal.transaction(async (client) => {
    await client.query('DELETE FROM meeting_attendance WHERE meeting_id = $1', [event.id]);
    for (const member of members) {
      const status = req.body[`member_${member.id}`] || 'absent';
      if (['present', 'excuse', 'absent'].includes(status)) {
        await client.query('INSERT INTO meeting_attendance (meeting_id, member_id, status) VALUES ($1, $2, $3)', [event.id, member.id, status]);
      }
    }
  });

  await dal.audit(req.session.user.id, 'update', 'event_attendance', event.id, { title: event.title });
  req.session.flash = { type: 'success', message: 'Attendance saved.' };
  res.redirect(`/secretary/meetings/events/${event.id}`);
}));

// ─── Send Event Reminder SMS ─────────────────────────────────────────────────

router.post('/events/:id/send-reminder', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const sms = require('./smsService');
  const result = await sms.sendEventReminder(event.id, req.session.user.id);

  if (result.error) {
    req.session.flash = { type: 'error', message: result.error };
  } else {
    req.session.flash = { type: 'success', message: `Reminder sent: ${result.sent} delivered, ${result.failed} failed.` };
  }
  await dal.audit(req.session.user.id, 'sms_send', 'event_reminder', event.id, { sent: result.sent, failed: result.failed });
  res.redirect(`/secretary/meetings/events/${event.id}`);
}));

// ─── Event Types Management ──────────────────────────────────────────────────

router.get('/event-types', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const commanderyId = getCommanderyId(req);
  const types = await dal.query('SELECT * FROM event_types WHERE commandery_id = $1 ORDER BY sort_order, name', [commanderyId]);
  res.render('secretary/event_types', { types });
}));

router.post('/event-types', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    req.session.flash = { type: 'error', message: 'Event type name is required.' };
    return res.redirect('/secretary/meetings/event-types');
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const commanderyId = getCommanderyId(req);

  await dal.run(
    'INSERT INTO event_types (commandery_id, name, slug, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (commandery_id, slug) DO UPDATE SET name = $2, active = true',
    [commanderyId, name, slug, Number(req.body.sort_order) || 0]
  );

  req.session.flash = { type: 'success', message: `Event type "${name}" added.` };
  res.redirect('/secretary/meetings/event-types');
}));

router.post('/event-types/:id/edit', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body.name || '').trim();
  if (!name) {
    req.session.flash = { type: 'error', message: 'Name is required.' };
    return res.redirect('/secretary/meetings/event-types');
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  await dal.run('UPDATE event_types SET name = $1, slug = $2, sort_order = $3 WHERE id = $4', [name, slug, Number(req.body.sort_order) || 0, id]);
  req.session.flash = { type: 'success', message: 'Event type updated.' };
  res.redirect('/secretary/meetings/event-types');
}));

router.post('/event-types/:id/delete', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  // Soft-delete (deactivate) so existing events with this type aren't broken
  await dal.run('UPDATE event_types SET active = false WHERE id = $1', [id]);
  req.session.flash = { type: 'success', message: 'Event type removed.' };
  res.redirect('/secretary/meetings/event-types');
}));

module.exports = router;
