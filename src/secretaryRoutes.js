'use strict';

const express = require('express');
const dal = require('./dal');
const { validateMeetingInput, MEETING_TYPES } = require('./secretaryDomain');

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Generate a Google Calendar "Add Event" URL.
 */
function googleCalendarUrl(event) {
  const date = new Date(event.meeting_date);
  const dateStr = date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const endDate = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  const endStr = endDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const typeLabel = event.meeting_type === 'regular' ? 'Regular Meeting' : event.meeting_type === 'special' ? 'Special Meeting' : 'Board of Trustees';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `KSJI ${typeLabel}`,
    dates: `${dateStr}/${endStr}`,
    details: '',
    location: event.location || ''
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── Events List ─────────────────────────────────────────────────────────────

router.get('/', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const commanderyId = getCommanderyId(req);
  const events = await dal.query(`
    SELECT e.*, u.name AS created_by_name,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'present')::int AS present_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'excuse')::int AS excuse_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = e.id AND ma.status = 'absent')::int AS absent_count
    FROM meetings e
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.commandery_id = $1
    ORDER BY e.meeting_date DESC
    LIMIT 50
  `, [commanderyId]);
  res.render('secretary/events', { events, MEETING_TYPES });
}));

// ─── Create Event ────────────────────────────────────────────────────────────

router.get('/new', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  res.render('secretary/event_form', { event: null, errors: [], MEETING_TYPES });
}));

router.post('/', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const errors = validateMeetingInput(req.body);
  if (errors.length) return res.status(400).render('secretary/event_form', { event: null, errors, values: req.body, MEETING_TYPES });

  const commanderyId = getCommanderyId(req);
  const result = await dal.run(`
    INSERT INTO meetings (commandery_id, meeting_date, meeting_type, location, start_time, other_notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [
    commanderyId, req.body.meeting_date, req.body.meeting_type,
    req.body.location || null, req.body.start_time || null,
    req.body.minutes_link || null, req.session.user.id
  ]);

  await dal.audit(req.session.user.id, 'create', 'meeting', result.rows[0].id, { date: req.body.meeting_date, type: req.body.meeting_type });
  req.session.flash = { type: 'success', message: 'Event created. Mark attendance when ready.' };
  res.redirect(`/secretary/meetings/${result.rows[0].id}`);
}));

// ─── Event Detail ────────────────────────────────────────────────────────────

router.get('/:id', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const attendance = await dal.query(`
    SELECT ma.*, m.name AS member_name
    FROM meeting_attendance ma
    JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1
    ORDER BY m.name
  `, [event.id]);

  res.render('secretary/event_detail', { event, attendance, googleCalendarUrl: googleCalendarUrl(event) });
}));

// ─── Edit Event ──────────────────────────────────────────────────────────────

router.get('/:id/edit', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });
  res.render('secretary/event_form', { event, errors: [], MEETING_TYPES });
}));

router.post('/:id', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const errors = validateMeetingInput(req.body);
  if (errors.length) return res.status(400).render('secretary/event_form', { event, errors, values: req.body, MEETING_TYPES });

  await dal.run(`
    UPDATE meetings SET
      meeting_date = $1, meeting_type = $2, location = $3,
      start_time = $4, other_notes = $5, updated_at = NOW()
    WHERE id = $6
  `, [
    req.body.meeting_date, req.body.meeting_type, req.body.location || null,
    req.body.start_time || null, req.body.minutes_link || null, event.id
  ]);

  await dal.audit(req.session.user.id, 'update', 'meeting', event.id, { date: req.body.meeting_date });
  req.session.flash = { type: 'success', message: 'Event updated.' };
  res.redirect(`/secretary/meetings/${event.id}`);
}));

// ─── Attendance ──────────────────────────────────────────────────────────────

router.get('/:id/attendance', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const members = await dal.query("SELECT id, name FROM members WHERE status = 'active' ORDER BY name");
  const existing = await dal.query('SELECT member_id, status FROM meeting_attendance WHERE meeting_id = $1', [event.id]);
  const attendanceMap = {};
  existing.forEach(r => { attendanceMap[r.member_id] = r.status; });

  res.render('secretary/attendance', { meeting: event, members, attendanceMap });
}));

router.post('/:id/attendance', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });

  const members = await dal.query("SELECT id FROM members WHERE status = 'active'");

  await dal.transaction(async (client) => {
    await client.query('DELETE FROM meeting_attendance WHERE meeting_id = $1', [event.id]);
    for (const member of members) {
      const status = req.body[`member_${member.id}`] || 'absent';
      if (['present', 'excuse', 'absent'].includes(status)) {
        await client.query(
          'INSERT INTO meeting_attendance (meeting_id, member_id, status) VALUES ($1, $2, $3)',
          [event.id, member.id, status]
        );
      }
    }
  });

  await dal.audit(req.session.user.id, 'update', 'meeting_attendance', event.id, { date: event.meeting_date });
  req.session.flash = { type: 'success', message: 'Attendance saved.' };
  res.redirect(`/secretary/meetings/${event.id}`);
}));

module.exports = router;
