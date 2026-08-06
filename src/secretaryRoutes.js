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
      pro_tem_appointments = $16, opening_rituals = $17, previous_minutes = $18,
      closing_notes = $19, discussion_notes = $20,
      updated_at = NOW()
    WHERE id = $21
  `, [
    req.body.meeting_date, req.body.meeting_type, req.body.location || null,
    req.body.start_time || null, req.body.end_time || null,
    req.body.opening_prayer_by || null, req.body.closing_prayer_by || null,
    req.body.mover || null, req.body.seconder || null,
    req.body.correspondence || null, req.body.finance_summary || null,
    req.body.matters_arising || null, req.body.agenda || null,
    req.body.good_of_order || null, req.body.other_notes || null,
    req.body.pro_tem_appointments || null, req.body.opening_rituals || null,
    req.body.previous_minutes || null, req.body.closing_notes || null,
    req.body.discussion_notes || null,
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
      if (['present', 'late', 'excuse', 'absent'].includes(status)) {
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

  // Attendance grouped by status
  const presentMembers = await dal.query(`
    SELECT m.name FROM meeting_attendance ma
    JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1 AND ma.status = 'present'
    ORDER BY m.name
  `, [meeting.id]);
  const lateMembers = await dal.query(`
    SELECT m.name FROM meeting_attendance ma
    JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1 AND ma.status = 'late'
    ORDER BY m.name
  `, [meeting.id]);
  const excusedMembers = await dal.query(`
    SELECT m.name FROM meeting_attendance ma
    JOIN members m ON m.id = ma.member_id
    WHERE ma.meeting_id = $1 AND ma.status = 'excuse'
    ORDER BY m.name
  `, [meeting.id]);

  const meetingDate = new Date(meeting.meeting_date);
  const dayName = meetingDate.toLocaleDateString('en-GB', { weekday: 'long' }).toUpperCase();
  const dateStr = meetingDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  const cmdName = commandery ? commandery.name.toUpperCase() : (org.name || '').toUpperCase();
  const cmdNumber = org.commandery_number || (commandery ? commandery.commandery_number : '');

  const doc = pdf.createDoc({
    title: `Minutes — ${meetingDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    subtitle: cmdName,
    groupName: org ? org.name : 'KSJI',
    org
  });

  // ─── HEADER ─────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(10).fillColor(pdf.COLORS.dark);
  doc.text(
    `MINUTES OF ${cmdName} COMMANDERY #${cmdNumber} OF THE KNIGHTS OF ST. JOHN INTERNATIONAL HELD ON ${dayName} ${dateStr}`,
    pdf.MARGIN, doc.y, { width: pdf.CONTENT_WIDTH, align: 'center' }
  );
  doc.moveDown(1.2);

  if (meeting.meeting_type === 'special') {
    // ─── INFORMAL MEETING: simple format ────────────────────────

    // Attendance (three-column)
    renderAttendanceTable(doc, presentMembers, lateMembers, excusedMembers);
    doc.moveDown(0.8);

    // Discussion notes
    if (meeting.discussion_notes) {
      pdf.sectionHeading(doc, 'Discussion');
      renderFormattedText(doc, meeting.discussion_notes);
      doc.moveDown(0.5);
    }

    if (meeting.other_notes) {
      pdf.sectionHeading(doc, 'Notes');
      renderFormattedText(doc, meeting.other_notes);
    }

  } else {
    // ─── FORMAL MEETING: numbered sections ──────────────────────
    let sectionNum = 1;

    // 1. COMMENCEMENT
    pdf.sectionHeading(doc, `${sectionNum}. Commencement`);
    sectionNum++;
    if (meeting.start_time) {
      const timeFormatted = formatTime12(meeting.start_time);
      doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
      doc.text(`The meeting began at ${timeFormatted}.`, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
      doc.moveDown(0.6);
    }

    // 2. ATTENDANCE
    pdf.sectionHeading(doc, `${sectionNum}. Attendance`);
    sectionNum++;
    renderAttendanceTable(doc, presentMembers, lateMembers, excusedMembers);
    doc.moveDown(0.8);

    // 3. PRO TEM APPOINTMENTS
    if (meeting.pro_tem_appointments) {
      pdf.sectionHeading(doc, `${sectionNum}. Pro Tem Appointments`);
      sectionNum++;
      renderFormattedText(doc, meeting.pro_tem_appointments);
      doc.moveDown(0.6);
    }

    // 4. OPENING RITUALS
    if (meeting.opening_rituals) {
      pdf.sectionHeading(doc, `${sectionNum}. Opening Rituals`);
      sectionNum++;
      renderFormattedText(doc, meeting.opening_rituals);
      doc.moveDown(0.6);
    }

    // 5. READING & ACCEPTANCE OF PREVIOUS MINUTES
    if (meeting.previous_minutes) {
      pdf.sectionHeading(doc, `${sectionNum}. Reading & Acceptance of Previous Minutes`);
      sectionNum++;
      renderFormattedText(doc, meeting.previous_minutes);
      doc.moveDown(0.6);
    }

    // 6. MATTERS ARISING & AGENDA
    if (meeting.matters_arising) {
      pdf.sectionHeading(doc, `${sectionNum}. Matters Arising & Agenda`);
      sectionNum++;
      renderFormattedText(doc, meeting.matters_arising);
      doc.moveDown(0.6);
    }

    // GOOD OF THE ORDER
    if (meeting.good_of_order) {
      pdf.sectionHeading(doc, `${sectionNum}. Good of the Order`);
      sectionNum++;
      renderFormattedText(doc, meeting.good_of_order);
      doc.moveDown(0.6);
    }

    // FINANCE
    if (meeting.finance_summary) {
      pdf.sectionHeading(doc, `${sectionNum}. Finance`);
      sectionNum++;
      renderFormattedText(doc, meeting.finance_summary);
      doc.moveDown(0.6);
    }

    // CORRESPONDENCE
    if (meeting.correspondence) {
      pdf.sectionHeading(doc, `${sectionNum}. Correspondence`);
      sectionNum++;
      renderFormattedText(doc, meeting.correspondence);
      doc.moveDown(0.6);
    }

    // CLOSING
    if (meeting.closing_notes || meeting.end_time) {
      pdf.sectionHeading(doc, `${sectionNum}. Closing`);
      if (meeting.closing_notes) {
        renderFormattedText(doc, meeting.closing_notes);
      } else if (meeting.end_time) {
        doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
        doc.text(`Meeting came to a close at ${formatTime12(meeting.end_time)}.`, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
      }
      doc.moveDown(0.6);
    }

    if (meeting.other_notes) {
      pdf.sectionHeading(doc, 'Other Notes');
      renderFormattedText(doc, meeting.other_notes);
    }
  }

  const monthName = meetingDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  pdf.sendPdf(res, doc, `Minutes-${monthName.replace(/\s+/g, '-')}.pdf`);
}));

/**
 * Render attendance as a three-column layout: Present | Late | Permission
 */
function renderAttendanceTable(doc, present, late, excused) {
  const colWidth = pdf.CONTENT_WIDTH / 3;
  const startY = doc.y;

  // Column headers
  doc.font('Helvetica-Bold').fontSize(8).fillColor(pdf.COLORS.primary);
  doc.text('A. Present', pdf.MARGIN, startY, { width: colWidth });
  doc.text('B. Late', pdf.MARGIN + colWidth, startY, { width: colWidth });
  doc.text('C. Permission', pdf.MARGIN + colWidth * 2, startY, { width: colWidth });

  const headerY = startY + 14;
  doc.moveTo(pdf.MARGIN, headerY).lineTo(pdf.MARGIN + pdf.CONTENT_WIDTH, headerY)
    .lineWidth(0.5).strokeColor(pdf.COLORS.border).stroke();
  doc.strokeColor('#000');

  // Names
  doc.font('Helvetica').fontSize(8.5).fillColor(pdf.COLORS.dark);
  const nameStartY = headerY + 6;
  const lineHeight = 13;

  const maxRows = Math.max(present.length, late.length, excused.length, 1);
  for (let i = 0; i < maxRows; i++) {
    const rowY = nameStartY + i * lineHeight;
    if (rowY > 720) { doc.addPage(); break; }
    if (present[i]) doc.text(present[i].name, pdf.MARGIN + 4, rowY, { width: colWidth - 8 });
    if (late[i]) doc.text(late[i].name, pdf.MARGIN + colWidth + 4, rowY, { width: colWidth - 8 });
    if (excused[i]) doc.text(excused[i].name, pdf.MARGIN + colWidth * 2 + 4, rowY, { width: colWidth - 8 });
  }

  doc.y = nameStartY + maxRows * lineHeight + 4;
}

/**
 * Render formatted text with paragraph spacing — handles numbered lists and sub-headings nicely.
 */
function renderFormattedText(doc, text) {
  if (!text) return;
  const lines = text.split('\n');
  doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);

  for (const line of lines) {
    if (doc.y > 730) doc.addPage();
    const trimmed = line.trim();
    if (!trimmed) {
      doc.moveDown(0.3);
      continue;
    }

    // Detect headings (A. Topic, B. Topic, i. Topic, etc.)
    const isHeading = /^[A-Z]\.\s/.test(trimmed) || /^[ivxIVX]+\.\s/.test(trimmed);
    if (isHeading) {
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(pdf.COLORS.dark);
      doc.text(trimmed, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
      doc.font('Helvetica').fontSize(9);
      doc.moveDown(0.15);
    } else {
      doc.font('Helvetica').fontSize(9).fillColor(pdf.COLORS.dark);
      doc.text(trimmed, pdf.MARGIN + 10, doc.y, { width: pdf.CONTENT_WIDTH - 10 });
      doc.moveDown(0.15);
    }
  }
}

/**
 * Format a 24h time string (HH:MM) to 12h with am/pm.
 */
function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
}

module.exports = router;
