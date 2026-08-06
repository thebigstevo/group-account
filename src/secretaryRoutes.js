'use strict';

const express = require('express');
const dal = require('./dal');
const pdf = require('./pdfReports');
const { validateMeetingInput, validateCharitableWork, validateVolunteerHours, MEETING_TYPES } = require('./secretaryDomain');

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

// ─── Meetings List ───────────────────────────────────────────────────────────

router.get('/', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const commanderyId = getCommanderyId(req);
  const meetings = await dal.query(`
    SELECT m.*, u.name AS created_by_name,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.status = 'present')::int AS present_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.status = 'excuse')::int AS excuse_count,
      (SELECT COUNT(*) FROM meeting_attendance ma WHERE ma.meeting_id = m.id AND ma.status = 'absent')::int AS absent_count
    FROM meetings m
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.commandery_id = $1
    ORDER BY m.meeting_date DESC
    LIMIT 50
  `, [commanderyId]);
  res.render('secretary/meetings', { meetings, MEETING_TYPES });
}));

// ─── Create Meeting ──────────────────────────────────────────────────────────

router.get('/new', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  res.render('secretary/meeting_form', { meeting: null, errors: [], MEETING_TYPES });
}));

router.post('/', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const errors = validateMeetingInput(req.body);
  if (errors.length) return res.status(400).render('secretary/meeting_form', { meeting: null, errors, values: req.body, MEETING_TYPES });

  const commanderyId = getCommanderyId(req);
  const result = await dal.run(`
    INSERT INTO meetings (commandery_id, meeting_date, meeting_type, location, created_by)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [commanderyId, req.body.meeting_date, req.body.meeting_type, req.body.location || null, req.session.user.id]);

  await dal.audit(req.session.user.id, 'create', 'meeting', result.rows[0].id, { date: req.body.meeting_date, type: req.body.meeting_type });
  req.session.flash = { type: 'success', message: 'Meeting created. Now mark attendance.' };
  res.redirect(`/secretary/meetings/${result.rows[0].id}/attendance`);
}));

// ─── Meeting Detail ──────────────────────────────────────────────────────────

router.get('/:id', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const attendance = await dal.query(`
    SELECT ma.*, m.name AS member_name
    FROM meeting_attendance ma
    JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1
    ORDER BY m.name
  `, [meeting.id]);

  const charitable = await dal.query(
    'SELECT * FROM charitable_works WHERE meeting_id = $1 ORDER BY id',
    [meeting.id]
  );
  const volunteer = await dal.query(
    'SELECT * FROM volunteer_hours WHERE meeting_id = $1 ORDER BY id',
    [meeting.id]
  );

  res.render('secretary/meeting_detail', { meeting, attendance, charitable, volunteer });
}));

// ─── Edit Meeting (minutes) ──────────────────────────────────────────────────

router.get('/:id/edit', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });
  res.render('secretary/meeting_form', { meeting, errors: [], MEETING_TYPES });
}));

router.post('/:id', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const errors = validateMeetingInput(req.body);
  if (errors.length) return res.status(400).render('secretary/meeting_form', { meeting, errors, values: req.body, MEETING_TYPES });

  await dal.run(`
    UPDATE meetings SET
      meeting_date = $1, meeting_type = $2, location = $3,
      start_time = $4, end_time = $5, opening_prayer_by = $6, closing_prayer_by = $7,
      mover = $8, seconder = $9, correspondence = $10, finance_summary = $11,
      matters_arising = $12, agenda = $13, good_of_order = $14, other_notes = $15,
      updated_at = NOW()
    WHERE id = $16
  `, [
    req.body.meeting_date, req.body.meeting_type, req.body.location || null,
    req.body.start_time || null, req.body.end_time || null,
    req.body.opening_prayer_by || null, req.body.closing_prayer_by || null,
    req.body.mover || null, req.body.seconder || null,
    req.body.correspondence || null, req.body.finance_summary || null,
    req.body.matters_arising || null, req.body.agenda || null,
    req.body.good_of_order || null, req.body.other_notes || null,
    meeting.id
  ]);

  await dal.audit(req.session.user.id, 'update', 'meeting', meeting.id, { date: req.body.meeting_date });
  req.session.flash = { type: 'success', message: 'Meeting updated.' };
  res.redirect(`/secretary/meetings/${meeting.id}`);
}));

// ─── Attendance ──────────────────────────────────────────────────────────────

router.get('/:id/attendance', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const members = await dal.query("SELECT id, name FROM members WHERE status = 'active' ORDER BY name");
  const existing = await dal.query('SELECT member_id, status FROM meeting_attendance WHERE meeting_id = $1', [meeting.id]);
  const attendanceMap = {};
  existing.forEach(r => { attendanceMap[r.member_id] = r.status; });

  res.render('secretary/attendance', { meeting, members, attendanceMap });
}));

router.post('/:id/attendance', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const members = await dal.query("SELECT id FROM members WHERE status = 'active'");

  await dal.transaction(async (client) => {
    await client.query('DELETE FROM meeting_attendance WHERE meeting_id = $1', [meeting.id]);
    for (const member of members) {
      const status = req.body[`member_${member.id}`] || 'absent';
      if (['present', 'excuse', 'absent'].includes(status)) {
        await client.query(
          'INSERT INTO meeting_attendance (meeting_id, member_id, status) VALUES ($1, $2, $3)',
          [meeting.id, member.id, status]
        );
      }
    }
  });

  await dal.audit(req.session.user.id, 'update', 'meeting_attendance', meeting.id, { date: meeting.meeting_date });
  req.session.flash = { type: 'success', message: 'Attendance saved.' };
  res.redirect(`/secretary/meetings/${meeting.id}`);
}));

// ─── Charitable Works ────────────────────────────────────────────────────────

router.post('/:id/charitable', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const errors = validateCharitableWork(req.body);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/secretary/meetings/${meeting.id}`);
  }

  const meetingDate = new Date(meeting.meeting_date);
  await dal.run(`
    INSERT INTO charitable_works (commandery_id, meeting_id, report_month, report_year, beneficiary, purpose, amount, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    getCommanderyId(req), meeting.id,
    meetingDate.getMonth() + 1, meetingDate.getFullYear(),
    req.body.beneficiary.trim(), req.body.purpose.trim(),
    Number(req.body.amount), req.session.user.id
  ]);

  req.session.flash = { type: 'success', message: 'Charitable work recorded.' };
  res.redirect(`/secretary/meetings/${meeting.id}`);
}));

router.post('/charitable/:id/delete', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const item = await dal.queryOne('SELECT * FROM charitable_works WHERE id = $1', [Number(req.params.id)]);
  if (!item) return res.status(404).render('error', { message: 'Not found.' });
  await dal.run('DELETE FROM charitable_works WHERE id = $1', [item.id]);
  req.session.flash = { type: 'success', message: 'Charitable work removed.' };
  res.redirect(`/secretary/meetings/${item.meeting_id}`);
}));

// ─── Volunteer Hours ─────────────────────────────────────────────────────────

router.post('/:id/volunteer', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const errors = validateVolunteerHours(req.body);
  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/secretary/meetings/${meeting.id}`);
  }

  const numBrothers = Number(req.body.num_brothers);
  const timeSpent = Number(req.body.time_spent);
  const totalHours = numBrothers * timeSpent;
  const meetingDate = new Date(meeting.meeting_date);

  await dal.run(`
    INSERT INTO volunteer_hours (commandery_id, meeting_id, report_month, report_year, num_brothers, time_spent, total_hours, purpose, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    getCommanderyId(req), meeting.id,
    meetingDate.getMonth() + 1, meetingDate.getFullYear(),
    numBrothers, timeSpent, totalHours,
    req.body.purpose.trim(), req.session.user.id
  ]);

  req.session.flash = { type: 'success', message: 'Volunteer hours recorded.' };
  res.redirect(`/secretary/meetings/${meeting.id}`);
}));

router.post('/volunteer/:id/delete', allow('admin', 'secretary'), asyncHandler(async (req, res) => {
  const item = await dal.queryOne('SELECT * FROM volunteer_hours WHERE id = $1', [Number(req.params.id)]);
  if (!item) return res.status(404).render('error', { message: 'Not found.' });
  await dal.run('DELETE FROM volunteer_hours WHERE id = $1', [item.id]);
  req.session.flash = { type: 'success', message: 'Volunteer hours removed.' };
  res.redirect(`/secretary/meetings/${item.meeting_id}`);
}));

// ─── Monthly Report PDF ──────────────────────────────────────────────────────

router.get('/:id/report', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const commanderyId = getCommanderyId(req);
  const org = await dal.queryOne('SELECT * FROM organization_settings WHERE id = 1');
  const commandery = await dal.queryOne('SELECT * FROM commanderies WHERE id = $1', [commanderyId]);

  // Attendance
  const attendance = await dal.query(`
    SELECT ma.status, COUNT(*)::int AS count
    FROM meeting_attendance ma WHERE ma.meeting_id = $1
    GROUP BY ma.status
  `, [meeting.id]);
  const attMap = { present: 0, excuse: 0, absent: 0 };
  attendance.forEach(r => { attMap[r.status] = r.count; });

  // Membership movements for the month
  const meetingDate = new Date(meeting.meeting_date);
  const mMonth = meetingDate.getMonth() + 1;
  const mYear = meetingDate.getFullYear();
  const monthStart = `${mYear}-${String(mMonth).padStart(2, '0')}-01`;
  const monthEnd = new Date(mYear, mMonth, 0).toISOString().slice(0, 10);

  const movements = await dal.query(`
    SELECT new_status, reason, COUNT(*)::int AS count
    FROM member_status_history
    WHERE commandery_id = $1 AND effective_date >= $2 AND effective_date <= $3
    GROUP BY new_status, reason
  `, [commanderyId, monthStart, monthEnd]);

  // Charitable works & volunteer hours for the month
  const charitable = await dal.query(
    'SELECT * FROM charitable_works WHERE commandery_id = $1 AND report_month = $2 AND report_year = $3 ORDER BY id',
    [commanderyId, mMonth, mYear]
  );
  const volunteer = await dal.query(
    'SELECT * FROM volunteer_hours WHERE commandery_id = $1 AND report_month = $2 AND report_year = $3 ORDER BY id',
    [commanderyId, mMonth, mYear]
  );

  // Secretary and President from users
  const secretary = await dal.queryOne("SELECT name, email FROM users WHERE role = 'secretary' AND active = true LIMIT 1");
  const president = await dal.queryOne("SELECT name, email FROM users WHERE role = 'president' AND active = true LIMIT 1");

  // Cadets roll
  const cadetsRoll = org ? (org.cadets_roll || 0) : 0;

  // Generate PDF
  const doc = pdf.createDoc({
    title: 'Monthly Report to Grand Secretary',
    subtitle: `${commandery ? commandery.name : org.name} — ${meetingDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}`,
    groupName: org ? org.name : 'KSJI',
    org
  });

  // Section 1: Header info
  pdf.sectionHeading(doc, 'Report Details');
  pdf.tableRow(doc, 'Organization', 'Knights of St. John International');
  pdf.tableRow(doc, 'Commandery Name', commandery ? commandery.name : (org.name || ''));
  pdf.tableRow(doc, 'Commandery Number', org.commandery_number || commandery.commandery_number || '');
  pdf.tableRow(doc, 'City/Town', org.city || '');
  pdf.tableRow(doc, 'Region/District', org.district || org.region || '');
  pdf.tableRow(doc, 'Date of Meeting', meeting.meeting_date);
  doc.moveDown(0.5);

  // Section 2: Attendance
  pdf.sectionHeading(doc, 'Meeting Attendance');
  pdf.tableRow(doc, 'Present', String(attMap.present));
  pdf.tableRow(doc, 'Excused', String(attMap.excuse));
  pdf.tableRow(doc, 'Absent', String(attMap.absent));
  doc.moveDown(0.5);

  // Section 3: Membership Movements
  pdf.sectionHeading(doc, 'Knights Membership Movements');
  pdf.labelRow(doc, 'IN:', { bold: true });
  const inMovements = { 'Initiated': 0, 'Transferred In': 0, 'Reinstated': 0 };
  const outMovements = { 'Withdrawn': 0, 'Expelled': 0, 'Died': 0, 'Suspended': 0, 'Transferred Out': 0 };

  movements.forEach(m => {
    const reason = (m.reason || '').toLowerCase();
    if (m.new_status === 'active') {
      if (reason.includes('initiat')) inMovements['Initiated'] += m.count;
      else if (reason.includes('transfer')) inMovements['Transferred In'] += m.count;
      else if (reason.includes('reinstat')) inMovements['Reinstated'] += m.count;
      else inMovements['Initiated'] += m.count;
    } else if (m.new_status === 'resigned') {
      outMovements['Withdrawn'] += m.count;
    } else if (m.new_status === 'expelled') {
      outMovements['Expelled'] += m.count;
    } else if (m.new_status === 'suspended') {
      outMovements['Suspended'] += m.count;
    } else if (m.new_status === 'transferred') {
      outMovements['Transferred Out'] += m.count;
    }
    if (reason.includes('died') || reason.includes('death') || reason.includes('deceased')) {
      outMovements['Died'] += m.count;
    }
  });

  Object.entries(inMovements).forEach(([label, count]) => {
    pdf.tableRow(doc, `  ${label}`, String(count));
  });
  doc.moveDown(0.3);
  pdf.labelRow(doc, 'OUT:', { bold: true });
  Object.entries(outMovements).forEach(([label, count]) => {
    pdf.tableRow(doc, `  ${label}`, String(count));
  });
  doc.moveDown(0.5);

  // Section 4: Cadets Roll
  pdf.sectionHeading(doc, 'Cadets Roll Movements');
  pdf.tableRow(doc, 'Current Roll', String(cadetsRoll));
  pdf.tableRow(doc, 'Additions for the month', '0');
  pdf.tableRow(doc, 'Deductions for the month', '0');
  pdf.tableRow(doc, 'Updated Roll', String(cadetsRoll));
  doc.moveDown(0.5);

  // Section 5: Charitable Works
  pdf.sectionHeading(doc, 'Charitable Works');
  if (charitable.length) {
    const cols = [
      { label: 'Beneficiary', width: 180, align: 'left' },
      { label: 'Purpose', width: 200, align: 'left' },
      { label: 'Amount (GH¢)', width: 100, align: 'right' }
    ];
    pdf.tableHeader(doc, cols);
    charitable.forEach((c, i) => {
      pdf.dataRow(doc, cols, [c.beneficiary, c.purpose, Number(c.amount).toFixed(2)], { rowIndex: i });
    });
  } else {
    pdf.tableRow(doc, 'No charitable works recorded this month.', '');
  }
  doc.moveDown(0.5);

  // Section 6: Volunteer Hours
  pdf.sectionHeading(doc, 'Monthly Volunteered Man Hours');
  if (volunteer.length) {
    const cols = [
      { label: 'Brothers', width: 70, align: 'center' },
      { label: 'Time (hrs)', width: 80, align: 'center' },
      { label: 'Total Hrs', width: 80, align: 'center' },
      { label: 'Purpose', width: 250, align: 'left' }
    ];
    pdf.tableHeader(doc, cols);
    volunteer.forEach((v, i) => {
      pdf.dataRow(doc, cols, [String(v.num_brothers), Number(v.time_spent).toFixed(1), Number(v.total_hours).toFixed(1), v.purpose], { rowIndex: i });
    });
  } else {
    pdf.tableRow(doc, 'No volunteer hours recorded this month.', '');
  }
  doc.moveDown(0.5);

  // Section 7: Contact Details
  pdf.sectionHeading(doc, 'Contact Details');
  pdf.tableRow(doc, 'Commandery Email', org.email || commandery.email || '');
  pdf.tableRow(doc, 'Secretary', secretary ? secretary.name : '');
  pdf.tableRow(doc, 'Secretary Phone', org.phone || '');
  doc.moveDown(0.5);

  // Section 8: Endorsement
  pdf.sectionHeading(doc, 'Endorsement');
  pdf.tableRow(doc, 'President', president ? president.name : '');
  doc.moveDown(2);

  // Signature lines
  doc.font('Helvetica').fontSize(8).fillColor(pdf.COLORS.muted);
  const sigY = doc.y;
  doc.moveTo(pdf.MARGIN, sigY).lineTo(pdf.MARGIN + 150, sigY).lineWidth(0.5).strokeColor(pdf.COLORS.muted).stroke();
  doc.text('Secretary Signature', pdf.MARGIN, sigY + 4);

  doc.moveTo(pdf.MARGIN + 250, sigY).lineTo(pdf.MARGIN + 400, sigY).lineWidth(0.5).strokeColor(pdf.COLORS.muted).stroke();
  doc.text('President Endorsement', pdf.MARGIN + 250, sigY + 4);
  doc.strokeColor('#000');

  const monthName = meetingDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  pdf.sendPdf(res, doc, `Monthly-Report-${monthName.replace(/\s+/g, '-')}.pdf`);
}));

// ─── Meeting Minutes PDF ─────────────────────────────────────────────────────

router.get('/:id/minutes', allow('admin', 'secretary', 'president', 'trustee'), asyncHandler(async (req, res) => {
  const meeting = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).render('error', { message: 'Meeting not found.' });

  const org = await dal.queryOne('SELECT * FROM organization_settings WHERE id = 1');
  const commandery = await dal.queryOne('SELECT * FROM commanderies WHERE id = $1', [getCommanderyId(req)]);

  const presentMembers = await dal.query(`
    SELECT m.name FROM meeting_attendance ma
    JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1 AND ma.status = 'present'
    ORDER BY m.name
  `, [meeting.id]);

  const doc = pdf.createDoc({
    title: `Minutes of Meeting — ${new Date(meeting.meeting_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    subtitle: commandery ? commandery.name : (org.name || ''),
    groupName: org ? org.name : 'KSJI',
    org
  });

  // Attendance list
  pdf.sectionHeading(doc, 'Members Present');
  if (presentMembers.length) {
    const nameList = presentMembers.map(m => m.name).join(', ');
    doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
    doc.text(nameList, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
    doc.moveDown(0.5);
  } else {
    doc.font('Helvetica').fontSize(9).text('No attendance recorded.', pdf.MARGIN + 10, doc.y);
    doc.moveDown(0.5);
  }

  // Meeting details
  if (meeting.start_time || meeting.opening_prayer_by) {
    pdf.sectionHeading(doc, 'Commencement');
    if (meeting.start_time) pdf.tableRow(doc, 'Start Time', meeting.start_time);
    if (meeting.opening_prayer_by) pdf.tableRow(doc, 'Opening Prayer By', meeting.opening_prayer_by);
    doc.moveDown(0.3);
  }

  if (meeting.correspondence) {
    pdf.sectionHeading(doc, 'Correspondence');
    doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
    doc.text(meeting.correspondence, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
    doc.moveDown(0.5);
  }

  if (meeting.finance_summary) {
    pdf.sectionHeading(doc, 'Finance Report');
    doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
    doc.text(meeting.finance_summary, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
    doc.moveDown(0.5);
  }

  if (meeting.matters_arising) {
    pdf.sectionHeading(doc, 'Matters Arising');
    doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
    doc.text(meeting.matters_arising, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
    doc.moveDown(0.5);
  }

  if (meeting.agenda) {
    pdf.sectionHeading(doc, 'Agenda / New Business');
    doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
    doc.text(meeting.agenda, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
    doc.moveDown(0.5);
  }

  if (meeting.good_of_order) {
    pdf.sectionHeading(doc, 'Good of the Order');
    doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
    doc.text(meeting.good_of_order, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
    doc.moveDown(0.5);
  }

  if (meeting.end_time || meeting.closing_prayer_by || meeting.mover) {
    pdf.sectionHeading(doc, 'Closing');
    if (meeting.mover) pdf.tableRow(doc, 'Motion to Close by', meeting.mover);
    if (meeting.seconder) pdf.tableRow(doc, 'Seconded by', meeting.seconder);
    if (meeting.closing_prayer_by) pdf.tableRow(doc, 'Closing Prayer By', meeting.closing_prayer_by);
    if (meeting.end_time) pdf.tableRow(doc, 'End Time', meeting.end_time);
  }

  const dateStr = new Date(meeting.meeting_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  pdf.sendPdf(res, doc, `Minutes-${dateStr.replace(/\s+/g, '-')}.pdf`);
}));

module.exports = router;
