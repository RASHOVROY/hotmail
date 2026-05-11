/**
 * Hotmail Temp Mail — Server
 * 
 * Express + Socket.IO + Microsoft Graph API email checking.
 * Reads accounts from accounts.txt (JSON format with tokens)
 * and exposes a web UI where anyone can pick an email,
 * use it for signups, and see incoming verification codes in real-time.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.txt');
const CHECK_INTERVAL_MS = 5000;      // Check every 5 seconds when watching
const MAX_EMAILS_TO_CHECK = 10;      // Check latest 10 emails per scan
const CODE_MAX_AGE_MS = 5 * 60 * 1000; // Codes older than 5 minutes are ignored

// ─── Load Accounts ──────────────────────────────────────────────────────────

function loadAccounts() {
  let content = '';

  // Check environment variable first (for cloud deployment like Render)
  if (process.env.ACCOUNTS_DATA) {
    console.log('📦 Loading accounts from ACCOUNTS_DATA environment variable...');
    content = process.env.ACCOUNTS_DATA;
  } else if (fs.existsSync(ACCOUNTS_FILE)) {
    content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  } else {
    console.error(`❌ No accounts found! Set ACCOUNTS_DATA env var or create ${ACCOUNTS_FILE}`);
    return [];
  }
  const accounts = [];

  // Split into entries — handles JSON objects (possibly multi-line)
  const entries = splitIntoEntries(content);

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    try {
      // Try JSON format first
      if (trimmed.startsWith('{')) {
        const obj = JSON.parse(trimmed);
        const email = obj.email || obj.username || '';
        if (!email) continue;

        accounts.push({
          id: accounts.length + 1,
          email,
          password: obj.password || '',
          clientId: obj.client_id || '',
          accessToken: obj.access_token || null,
          refreshToken: obj.refresh_token || '',
          graphAccessToken: obj.graph_access_token || null,
          graphRefreshToken: obj.graph_refresh_token || '',
          // Runtime state
          status: 'available',
          latestCode: null,
          codeFoundAt: null,
          lastChecked: null,
          error: null
        });
      } else {
        // Simple email:password or email;password format
        const sepIndex = trimmed.indexOf(':') !== -1 ? trimmed.indexOf(':') : trimmed.indexOf(';');
        if (sepIndex === -1) continue;

        const email = trimmed.substring(0, sepIndex).trim();
        const password = trimmed.substring(sepIndex + 1).trim();
        if (!email || !password) continue;

        accounts.push({
          id: accounts.length + 1,
          email,
          password,
          clientId: '',
          accessToken: null,
          refreshToken: '',
          graphAccessToken: null,
          graphRefreshToken: '',
          status: 'available',
          latestCode: null,
          codeFoundAt: null,
          lastChecked: null,
          error: null
        });
      }
    } catch (err) {
      console.warn(`⚠️ Failed to parse entry: ${trimmed.substring(0, 40)}... — ${err.message}`);
    }
  }

  console.log(`📧 Loaded ${accounts.length} account(s) from accounts.txt`);
  return accounts;
}

/**
 * Split bulk text into individual entries.
 * Handles multi-line JSON objects by tracking brace depth.
 */
function splitIntoEntries(text) {
  const entries = [];
  let current = '';
  let braceDepth = 0;
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      current += ch;
      continue;
    }
    if (!inString) {
      if (ch === '{') { braceDepth++; current += ch; continue; }
      if (ch === '}') {
        braceDepth--;
        current += ch;
        if (braceDepth === 0) {
          entries.push(current.trim());
          current = '';
        }
        continue;
      }
      if (ch === '\n' && braceDepth === 0) {
        if (current.trim()) entries.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

const accounts = loadAccounts();

// ─── Active Watchers ────────────────────────────────────────────────────────

const activeWatchers = new Map(); // email → { interval }

// ─── OTP Extraction ─────────────────────────────────────────────────────────

function extractOTP(subject, textBody, htmlBody) {
  const text = `${subject || ''}\n${textBody || ''}\n${stripHtml(htmlBody || '')}`;
  
  const patterns = [
    /(?:verification|verify|confirmation|security)\s*code[\s:]*(\d{4,8})/i,
    /(?:otp|one.time.password)[\s:]*(\d{4,8})/i,
    /\bcode[\s:]+(\d{4,8})\b/i,
    /enter\s+(\d{4,8})\s+to/i,
    /(\d{4,8})\s+is\s+your\s+(?:verification|confirmation|security)\s*code/i,
    /\bpin[\s:]+(\d{4,8})\b/i,
    /^\s*(\d{6})\s*$/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const code = match[1];
      const num = parseInt(code);
      if (code.length >= 4 && code.length <= 8 && !(num >= 1900 && num <= 2099)) {
        return code;
      }
    }
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Microsoft Graph API Email Checking ─────────────────────────────────────

/**
 * Get a valid Graph API access token for an account.
 * Strategy:
 *   1. Use stored graph_access_token directly (don't check expiry — let the API tell us)
 *   2. If API returns 401, refresh with graph_refresh_token using .default scope
 *   3. If that fails, try regular refresh_token
 */
async function getGraphToken(account, forceRefresh = false) {
  // 1. Try stored graph access token first (unless forced refresh)
  if (!forceRefresh && account.graphAccessToken) {
    return account.graphAccessToken;
  }

  // 2. Try refreshing with graph_refresh_token
  const refreshAttempts = [
    { token: account.graphRefreshToken, label: 'graph_refresh_token' },
    { token: account.refreshToken, label: 'refresh_token' }
  ].filter(a => a.token && account.clientId);

  for (const attempt of refreshAttempts) {
    console.log(`  🔄 Refreshing via ${attempt.label} for ${account.email}...`);

    try {
      const response = await fetch(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: account.clientId,
            scope: 'https://graph.microsoft.com/.default offline_access',
            refresh_token: attempt.token,
            grant_type: 'refresh_token'
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        console.log(`  ⚠️ ${attempt.label} failed: ${data.error}`);
        continue;
      }

      // Success — update stored tokens
      account.graphAccessToken = data.access_token;
      if (data.refresh_token) {
        account.graphRefreshToken = data.refresh_token;
      }

      console.log(`  ✅ Graph token refreshed via ${attempt.label}`);
      return data.access_token;
    } catch (err) {
      console.log(`  ⚠️ ${attempt.label} error: ${err.message}`);
    }
  }

  throw new Error('All token refresh attempts failed');
}

/**
 * Check emails via Microsoft Graph API for verification codes.
 * Checks Junk folder first (most verification emails land there), then Inbox.
 */
async function checkEmailForCodes(account) {
  const token = await getGraphToken(account);
  const cutoff = new Date(Date.now() - CODE_MAX_AGE_MS).toISOString();

  // Check folders: Junk first, then Inbox
  const folders = ['junkemail', 'inbox'];

  for (const folder of folders) {
    try {
      const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?` +
        `$top=${MAX_EMAILS_TO_CHECK}&` +
        `$orderby=receivedDateTime desc&` +
        `$select=id,subject,from,receivedDateTime,bodyPreview,body&` +
        `$filter=receivedDateTime ge ${cutoff}`;

      const response = await fetch(url, {
        headers: { 
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 401) {
        // Token expired, force refresh and retry
        console.log(`  ⚠️ 401 for ${folder}, forcing token refresh...`);
        const newToken = await getGraphToken(account, true);
        const retryResponse = await fetch(url, {
          headers: { Authorization: `Bearer ${newToken}` }
        });
        var data = await retryResponse.json();
      } else {
        var data = await response.json();
      }

      if (data.error) {
        console.log(`  ⚠️ Graph API error for ${folder}: ${data.error.message}`);
        continue;
      }

      const messages = data.value || [];

      for (const msg of messages) {
        const code = extractOTP(
          msg.subject,
          msg.bodyPreview,
          msg.body?.content
        );

        if (code) {
          return {
            code,
            subject: msg.subject || '(No subject)',
            from: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown',
            fromEmail: msg.from?.emailAddress?.address || '',
            date: msg.receivedDateTime,
            folder: folder === 'junkemail' ? 'Junk' : 'Inbox'
          };
        }
      }
    } catch (folderErr) {
      console.log(`  ⚠️ Error checking ${folder}: ${folderErr.message}`);
    }
  }

  return null;
}

// ─── Express + Socket.IO Server ─────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// API: Get all accounts (sensitive data hidden)
app.get('/api/accounts', (req, res) => {
  res.json(accounts.map(sanitizeAccount));
});

function sanitizeAccount(a) {
  return {
    id: a.id,
    email: a.email,
    status: a.status,
    latestCode: a.latestCode,
    codeFoundAt: a.codeFoundAt,
    lastChecked: a.lastChecked,
    error: a.error,
    hasGraphToken: !!(a.graphAccessToken || a.graphRefreshToken),
    hasRefreshToken: !!a.refreshToken
  };
}

// ─── Socket.IO Events ──────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.emit('accounts-update', accounts.map(sanitizeAccount));

  // ── Watch an email for incoming codes ──
  socket.on('watch-email', async (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    if (!account) {
      socket.emit('error-msg', { message: 'Account not found' });
      return;
    }

    stopWatcher(account.email);

    console.log(`👁️ Watching: ${account.email}`);
    account.status = 'watching';
    account.latestCode = null;
    account.codeFoundAt = null;
    account.error = null;
    broadcastAccountUpdate(account);

    const checkFn = async () => {
      try {
        console.log(`  🔍 Checking ${account.email}...`);
        account.lastChecked = new Date().toISOString();
        
        const result = await checkEmailForCodes(account);
        
        if (result) {
          console.log(`  ✅ Code found for ${account.email}: ${result.code} (${result.folder})`);
          account.status = 'code_found';
          account.latestCode = result;
          account.codeFoundAt = new Date().toISOString();
        }
        
        broadcastAccountUpdate(account);
      } catch (err) {
        console.error(`  ❌ Error checking ${account.email}: ${err.message}`);
        account.error = err.message;
        account.status = 'error';
        broadcastAccountUpdate(account);
        stopWatcher(account.email);
      }
    };

    await checkFn();
    const interval = setInterval(checkFn, CHECK_INTERVAL_MS);
    activeWatchers.set(account.email, { interval });
  });

  socket.on('stop-watch', (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
      stopWatcher(account.email);
      account.status = account.latestCode ? 'code_found' : 'available';
      broadcastAccountUpdate(account);
      console.log(`🛑 Stopped watching: ${account.email}`);
    }
  });

  socket.on('reset-account', (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
      stopWatcher(account.email);
      account.status = 'available';
      account.latestCode = null;
      account.codeFoundAt = null;
      account.error = null;
      broadcastAccountUpdate(account);
      console.log(`🔄 Reset: ${account.email}`);
    }
  });

  socket.on('check-once', async (accountId) => {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;

    console.log(`🔍 One-time check: ${account.email}`);
    account.lastChecked = new Date().toISOString();

    try {
      const result = await checkEmailForCodes(account);
      if (result) {
        account.status = 'code_found';
        account.latestCode = result;
        account.codeFoundAt = new Date().toISOString();
      }
      account.error = null;
    } catch (err) {
      account.error = err.message;
      account.status = 'error';
    }

    broadcastAccountUpdate(account);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

function stopWatcher(email) {
  const watcher = activeWatchers.get(email);
  if (watcher) {
    clearInterval(watcher.interval);
    activeWatchers.delete(email);
  }
}

function broadcastAccountUpdate(account) {
  io.emit('account-update', sanitizeAccount(account));
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  for (const [, watcher] of activeWatchers) {
    clearInterval(watcher.interval);
  }
  activeWatchers.clear();
  process.exit(0);
});

// ─── Start Server ───────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const graphCount = accounts.filter(a => a.graphAccessToken || a.graphRefreshToken).length;
  console.log(`
╔═══════════════════════════════════════════════════╗
║          🔥 Hotmail Temp Mail Server 🔥           ║
╠═══════════════════════════════════════════════════╣
║                                                   ║
║   URL:  http://localhost:${PORT}                     ║
║   Accounts loaded: ${String(accounts.length).padEnd(3)}                          ║
║   With Graph tokens: ${String(graphCount).padEnd(3)}                        ║
║                                                   ║
║   Open the URL in any browser to start!           ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
  `);
});
