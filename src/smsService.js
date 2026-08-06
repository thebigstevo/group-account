'use strict';

const dal = require('./dal');

/**
 * SMS Service — mNotify integration.
 * Config (API key, sender ID, etc.) is stored in organization_settings and loaded on demand.
 */

const MNOTIFY_BASE_URL = 'https://apps.mnotify.net/smsapi';

/**
 * Normalize a Ghanaian phone number to 233XXXXXXXXX format.
 * Handles: 0244xxx, +233244xxx, 233244xxx, 244xxx
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/[\s\-().+]/g, '');
  if (cleaned.startsWith('00233')) cleaned = cleaned.slice(2);
  if (cleaned.startsWith('233') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('0') && cleaned.length === 10) return '233' + cleaned.slice(1);
  if (cleaned.length === 9 && !cleaned.startsWith('0')) return '233' + cleaned;
  // Return as-is if format is unclear
  return cleaned;
}

/**
 * Load SMS config from organization_settings.
 */
async function getConfig() {
  const org = await dal.queryOne('SELECT sms_api_key, sms_sender_id, sms_enabled, sms_event_reminder_days, sms_payment_notify FROM organization_settings WHERE id = 1');
  return org || { sms_api_key: null, sms_sender_id: 'KSJI', sms_enabled: false, sms_event_reminder_days: 2, sms_payment_notify: true };
}

/**
 * Send a single SMS via mNotify.
 * @param {string} to - Phone number (will be normalized)
 * @param {string} message - Message content
 * @param {object} config - { sms_api_key, sms_sender_id }
 * @returns {object} { success, messageId, error }
 */
async function sendSms(to, message, config) {
  if (!config.sms_api_key) return { success: false, error: 'SMS API key not configured' };
  if (!config.sms_enabled) return { success: false, error: 'SMS is disabled' };

  const phone = normalizePhone(to);
  if (!phone) return { success: false, error: 'Invalid phone number' };

  const params = new URLSearchParams({
    key: config.sms_api_key,
    to: phone,
    msg: message,
    sender_id: config.sms_sender_id || 'KSJI'
  });

  try {
    const response = await fetch(`${MNOTIFY_BASE_URL}?${params.toString()}`);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = { code: text }; }

    // mNotify returns code "1000" for success
    if (data.code === '1000' || data.code === 1000 || data.status === 'success') {
      return { success: true, messageId: data.message_id || data.id || null };
    }
    return { success: false, error: `mNotify error: ${data.code || data.message || text}` };
  } catch (err) {
    return { success: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Send SMS and log it to the database.
 * @param {object} opts
 * @param {string} opts.phone - Recipient phone
 * @param {string} opts.name - Recipient name (for logging)
 * @param {number|null} opts.memberId - Member ID
 * @param {string} opts.message - SMS content
 * @param {string} opts.smsType - 'event_reminder' | 'payment_confirmation' | 'assessment_reminder' | 'general'
 * @param {number|null} opts.sentBy - User ID who triggered the send
 * @param {number|null} opts.commanderyId - Commandery ID
 */
async function sendAndLog(opts) {
  const config = await getConfig();
  const result = await sendSms(opts.phone, opts.message, config);

  await dal.run(`
    INSERT INTO sms_log (commandery_id, recipient_phone, recipient_name, member_id, message, sms_type, status, provider_ref, error_message, sent_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    opts.commanderyId || null,
    normalizePhone(opts.phone),
    opts.name || null,
    opts.memberId || null,
    opts.message,
    opts.smsType || 'general',
    result.success ? 'sent' : 'failed',
    result.messageId || null,
    result.error || null,
    opts.sentBy || null
  ]);

  return result;
}

/**
 * Send event reminder to all active members with phone numbers.
 */
async function sendEventReminder(eventId, sentBy) {
  const config = await getConfig();
  if (!config.sms_enabled || !config.sms_api_key) {
    return { sent: 0, failed: 0, error: 'SMS not configured or disabled' };
  }

  const event = await dal.queryOne('SELECT * FROM meetings WHERE id = $1', [eventId]);
  if (!event) return { sent: 0, failed: 0, error: 'Event not found' };

  const members = await dal.query("SELECT id, name, phone FROM members WHERE status = 'active' AND phone IS NOT NULL AND phone != ''");
  const eventDate = new Date(event.meeting_date);
  const dateStr = eventDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const eventName = event.title || 'meeting';
  const location = event.location ? ` at ${event.location}` : '';
  const time = event.start_time ? ` by ${formatTime12(event.start_time)}` : '';

  let sent = 0, failed = 0;
  for (const member of members) {
    const firstName = member.name.split(' ')[0];
    const message = `Dear ${firstName}, reminder: ${eventName} on ${dateStr}${time}${location}. Attendance is expected. - KSJI`;

    const result = await sendAndLog({
      phone: member.phone,
      name: member.name,
      memberId: member.id,
      message,
      smsType: 'event_reminder',
      sentBy,
      commanderyId: null
    });

    if (result.success) sent++; else failed++;
  }

  return { sent, failed, total: members.length };
}

/**
 * Send payment confirmation to a member.
 */
async function sendPaymentConfirmation(memberId, amount, category, sentBy) {
  const config = await getConfig();
  if (!config.sms_enabled || !config.sms_api_key || !config.sms_payment_notify) return { success: false };

  const member = await dal.queryOne('SELECT id, name, phone FROM members WHERE id = $1', [memberId]);
  if (!member || !member.phone) return { success: false, error: 'No phone number' };

  const firstName = member.name.split(' ')[0];
  const amtStr = Number(amount).toFixed(2);
  const message = `Dear ${firstName}, your payment of GHS ${amtStr} for ${category} has been received and confirmed. Thank you. - KSJI`;

  return sendAndLog({
    phone: member.phone,
    name: member.name,
    memberId: member.id,
    message,
    smsType: 'payment_confirmation',
    sentBy,
    commanderyId: null
  });
}

/**
 * Send assessment reminders to members with outstanding balances.
 */
async function sendAssessmentReminders(year, memberDueFn, sentBy) {
  const config = await getConfig();
  if (!config.sms_enabled || !config.sms_api_key) {
    return { sent: 0, failed: 0, error: 'SMS not configured or disabled' };
  }

  const members = await dal.query("SELECT * FROM members WHERE status = 'active' AND phone IS NOT NULL AND phone != ''");
  let sent = 0, failed = 0;

  for (const member of members) {
    const due = await memberDueFn(member, year);
    const assessmentDue = Number(due.assessment_due);
    if (assessmentDue <= 0) continue;

    // Calculate paid
    const paidRow = await dal.queryOne(`
      SELECT COALESCE(SUM(t.amount), 0) AS total
      FROM transactions t
      JOIN transaction_categories c ON c.name = t.category
      WHERE t.member_id = $1 AND t.tx_type = 'receipt' AND t.status = 'posted'
        AND c.purpose = 'assessment'
        AND t.tx_date >= $2 AND t.tx_date <= $3
    `, [member.id, `${year}-01-01`, `${year}-12-31`]);

    const balance = Number(member.opening_arrears || 0) + assessmentDue - Number(paidRow.total);
    if (balance <= 0) continue;

    const firstName = member.name.split(' ')[0];
    const message = `Dear ${firstName}, your outstanding assessment balance for ${year} is GHS ${balance.toFixed(2)}. Kindly make payment at your earliest convenience. - KSJI`;

    const result = await sendAndLog({
      phone: member.phone,
      name: member.name,
      memberId: member.id,
      message,
      smsType: 'assessment_reminder',
      sentBy,
      commanderyId: null
    });

    if (result.success) sent++; else failed++;
  }

  return { sent, failed };
}

function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour12}:${String(m).padStart(2, '0')}${ampm}`;
}

module.exports = {
  normalizePhone,
  getConfig,
  sendSms,
  sendAndLog,
  sendEventReminder,
  sendPaymentConfirmation,
  sendAssessmentReminders
};
