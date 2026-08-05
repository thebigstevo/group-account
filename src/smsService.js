/**
 * SMS Service for Treasurio
 * Supports Africa's Talking API for sending SMS notifications.
 * Configure via organization settings or environment variables.
 */
const https = require('https');
const dal = require('./dal');

/**
 * Get SMS configuration from environment or DB.
 */
function getSmsConfig() {
  return {
    enabled: process.env.SMS_ENABLED === 'true',
    provider: process.env.SMS_PROVIDER || 'africastalking', // 'africastalking' or 'mock'
    apiKey: process.env.AT_API_KEY || '',
    username: process.env.AT_USERNAME || 'sandbox',
    senderId: process.env.SMS_SENDER_ID || ''
  };
}

/**
 * Send an SMS via Africa's Talking.
 * @param {string} phone - Recipient phone (international format)
 * @param {string} message - SMS content (max 160 chars for single SMS)
 * @returns {Object} { success, messageId, error }
 */
async function sendSms(phone, message) {
  const config = getSmsConfig();

  if (!config.enabled) {
    console.log(`[SMS] Disabled. Would send to ${phone}: ${message}`);
    return { success: false, error: 'SMS not enabled' };
  }

  if (config.provider === 'mock') {
    console.log(`[SMS MOCK] → ${phone}: ${message}`);
    return { success: true, messageId: 'mock-' + Date.now() };
  }

  // Africa's Talking API
  const postData = `username=${encodeURIComponent(config.username)}&to=${encodeURIComponent(phone)}&message=${encodeURIComponent(message)}${config.senderId ? '&from=' + encodeURIComponent(config.senderId) : ''}`;

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.africastalking.com',
      port: 443,
      path: '/version1/messaging',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'apiKey': config.apiKey,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const recipients = result.SMSMessageData?.Recipients || [];
          if (recipients.length > 0 && recipients[0].status === 'Success') {
            resolve({ success: true, messageId: recipients[0].messageId });
          } else {
            resolve({ success: false, error: recipients[0]?.status || 'Unknown error' });
          }
        } catch (e) {
          resolve({ success: false, error: 'Parse error: ' + data.slice(0, 100) });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(postData);
    req.end();
  });
}

/**
 * Send payment confirmation to a member.
 * @param {number} memberId
 * @param {number} amount
 * @param {string} category
 * @param {string} date
 */
async function sendPaymentConfirmation(memberId, amount, category, date) {
  const member = await dal.queryOne('SELECT name, phone FROM members WHERE id = $1', [memberId]);
  if (!member || !member.phone) return { success: false, error: 'No phone number' };

  const org = await dal.queryOne('SELECT name, short_name FROM organization_settings WHERE id = 1');
  const orgName = (org && org.short_name) || (org && org.name) || 'Treasurio';

  const msg = `${orgName}: Payment of GHS ${Number(amount).toFixed(2)} received (${category}) on ${date}. Thank you, ${member.name.split(' ')[0]}.`;
  const result = await sendSms(member.phone, msg);

  // Log the SMS
  await dal.run(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES ($1, 'sms_sent', 'member', $2, $3)
  `, [null, memberId, JSON.stringify({ phone: member.phone, message: msg, result })]);

  return result;
}

/**
 * Send arrears reminder to a member.
 * @param {number} memberId
 * @param {number} balance - Outstanding amount
 * @param {number} year
 */
async function sendArrearsReminder(memberId, balance, year) {
  const member = await dal.queryOne('SELECT name, phone FROM members WHERE id = $1', [memberId]);
  if (!member || !member.phone) return { success: false, error: 'No phone number' };

  const org = await dal.queryOne('SELECT name, short_name FROM organization_settings WHERE id = 1');
  const orgName = (org && org.short_name) || (org && org.name) || 'Treasurio';

  const msg = `${orgName} Reminder: Dear ${member.name.split(' ')[0]}, your outstanding balance for ${year} is GHS ${Number(balance).toFixed(2)}. Kindly make payment at your earliest convenience.`;
  const result = await sendSms(member.phone, msg);

  await dal.run(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES ($1, 'sms_sent', 'member', $2, $3)
  `, [null, memberId, JSON.stringify({ phone: member.phone, message: msg, result })]);

  return result;
}

/**
 * Send bulk arrears reminders to all members with outstanding balances.
 * @param {number} year
 * @param {number} userId - The admin who triggered it
 * @returns {Object} { sent, failed, skipped }
 */
async function sendBulkArrearsReminders(year, userId) {
  const { arrearsReport } = require('./services');
  const arrears = await arrearsReport(year);
  const membersOwing = arrears.filter(r => r.balance > 0);

  let sent = 0, failed = 0, skipped = 0;

  for (const row of membersOwing) {
    if (!row.phone) { skipped++; continue; }
    const result = await sendArrearsReminder(row.member_id, row.balance, year);
    if (result.success) sent++;
    else failed++;

    // Rate limit: 1 SMS per 500ms to avoid throttling
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await dal.run(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES ($1, 'bulk_sms', 'arrears_reminder', NULL, $2)
  `, [userId, JSON.stringify({ year, sent, failed, skipped, total: membersOwing.length })]);

  return { sent, failed, skipped, total: membersOwing.length };
}

module.exports = {
  getSmsConfig,
  sendSms,
  sendPaymentConfirmation,
  sendArrearsReminder,
  sendBulkArrearsReminders
};
