/**
 * TempMail Frontend — Socket.IO Client + UI Logic
 * 
 * Connects to the server, renders email cards, handles
 * copy-to-clipboard, watch/stop, and real-time code updates.
 */

// ─── DOM References ─────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const emailGrid = $('#email-grid');
const emptyState = $('#empty-state');
const loadingState = $('#loading-state');
const codeBanner = $('#code-banner');
const codeBannerCode = $('#code-banner-code');
const codeBannerEmail = $('#code-banner-email');
const codeBannerFrom = $('#code-banner-from');
const codeBannerSubject = $('#code-banner-subject');
const searchInput = $('#search-input');
const toastEl = $('#toast');
const connStatus = $('#connection-status');
const connText = $('.conn-text');

// ─── State ──────────────────────────────────────────────────────────────────

let accounts = [];
let activeFilter = 'all';
let searchQuery = '';
let latestCodeAccountId = null;

// ─── Socket.IO Connection ───────────────────────────────────────────────────

const socket = io();

socket.on('connect', () => {
  console.log('🔌 Connected to server');
  connStatus.classList.remove('disconnected');
  connText.textContent = 'Connected';
});

socket.on('disconnect', () => {
  console.log('🔌 Disconnected from server');
  connStatus.classList.add('disconnected');
  connText.textContent = 'Disconnected';
});

// Initial full account list
socket.on('accounts-update', (data) => {
  accounts = data;
  loadingState.classList.add('hidden');
  renderAll();
  updateStats();
});

// Single account update (real-time)
socket.on('account-update', (updated) => {
  const idx = accounts.findIndex(a => a.id === updated.id);
  if (idx !== -1) {
    accounts[idx] = updated;
  } else {
    accounts.push(updated);
  }

  // If a code was found, show the banner
  if (updated.status === 'code_found' && updated.latestCode) {
    showCodeBanner(updated);
  }

  renderAll();
  updateStats();
});

socket.on('error-msg', (data) => {
  showToast(`❌ ${data.message}`, 'error');
});

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderAll() {
  const filtered = getFilteredAccounts();

  if (accounts.length === 0) {
    emailGrid.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  emailGrid.classList.remove('hidden');

  if (filtered.length === 0) {
    emailGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
        <p style="font-size: 16px;">No emails match your search.</p>
      </div>
    `;
    return;
  }

  emailGrid.innerHTML = filtered.map(acc => renderCard(acc)).join('');
}

function renderCard(acc) {
  const statusLabel = {
    available: 'Available',
    watching: 'Watching…',
    code_found: 'Code Found',
    error: 'Error'
  }[acc.status] || acc.status;

  const codeSection = acc.latestCode ? `
    <div class="card-code">
      <div class="card-code-value">${acc.latestCode.code}</div>
      <div class="card-code-meta">
        ${acc.latestCode.folder || ''}<br>
        ${formatTime(acc.latestCode.date)}
      </div>
    </div>
  ` : '';

  const errorSection = acc.error ? `
    <div class="card-error">${escapeHtml(acc.error)}</div>
  ` : '';

  // Determine which action buttons to show
  let actions = '';
  
  // Always show copy email
  actions += `
    <button class="card-btn btn-copy-email" data-action="copy-email" data-id="${acc.id}" data-email="${escapeAttr(acc.email)}" title="Copy email">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      Copy Email
    </button>
  `;

  if (acc.status === 'available' || acc.status === 'error') {
    actions += `
      <button class="card-btn btn-watch" data-action="watch" data-id="${acc.id}" title="Watch for verification codes">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Watch for Code
      </button>
    `;
  } else if (acc.status === 'watching') {
    actions += `
      <button class="card-btn btn-watching" data-action="stop" data-id="${acc.id}" title="Stop watching">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6"/></svg>
        Watching…
      </button>
    `;
  } else if (acc.status === 'code_found') {
    actions += `
      <button class="card-btn btn-copy-code" data-action="copy-code" data-id="${acc.id}" data-code="${acc.latestCode?.code || ''}" title="Copy verification code">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        Copy Code
      </button>
    `;
  }

  // Reset button (always, except for available)
  if (acc.status !== 'available') {
    actions += `
      <button class="card-btn btn-reset" data-action="reset" data-id="${acc.id}" title="Reset">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
      </button>
    `;
  }

  return `
    <div class="email-card" data-status="${acc.status}" data-id="${acc.id}">
      <div class="card-header">
        <div class="card-serial">${acc.id}</div>
        <div class="card-email">${escapeHtml(acc.email)}</div>
        <div class="card-status ${acc.status}">${statusLabel}</div>
      </div>
      ${codeSection}
      ${errorSection}
      <div class="card-actions">
        ${actions}
      </div>
    </div>
  `;
}

// ─── Code Banner ────────────────────────────────────────────────────────────

function showCodeBanner(account) {
  if (!account.latestCode) return;

  latestCodeAccountId = account.id;
  codeBannerCode.textContent = account.latestCode.code;
  codeBannerEmail.textContent = account.email;
  codeBannerFrom.textContent = `From: ${account.latestCode.from || 'Unknown'}`;
  codeBannerSubject.textContent = `Subject: ${account.latestCode.subject || ''}`;
  codeBanner.classList.remove('hidden');

  // Auto-copy the code
  copyToClipboard(account.latestCode.code);
  showToast(`🔑 Code ${account.latestCode.code} found & copied!`, 'success');
}

// ─── Event Handlers ─────────────────────────────────────────────────────────

// Email grid click delegation
emailGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.card-btn');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = parseInt(btn.dataset.id);

  switch (action) {
    case 'copy-email': {
      const email = btn.dataset.email;
      copyToClipboard(email);
      showToast(`📋 ${email} copied!`, 'success');
      break;
    }

    case 'watch': {
      socket.emit('watch-email', id);
      showToast('👁️ Watching for verification codes...', 'success');
      break;
    }

    case 'stop': {
      socket.emit('stop-watch', id);
      showToast('🛑 Stopped watching', 'success');
      break;
    }

    case 'copy-code': {
      const code = btn.dataset.code;
      if (code) {
        copyToClipboard(code);
        showToast(`📋 Code ${code} copied!`, 'success');
      }
      break;
    }

    case 'reset': {
      socket.emit('reset-account', id);
      // If this was the banner account, hide banner
      if (latestCodeAccountId === id) {
        codeBanner.classList.add('hidden');
        latestCodeAccountId = null;
      }
      break;
    }
  }
});

// Code banner copy button
$('#btn-copy-code').addEventListener('click', () => {
  const code = codeBannerCode.textContent;
  if (code) {
    copyToClipboard(code);
    showToast(`📋 Code ${code} copied!`, 'success');
  }
});

// Search
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderAll();
});

// Filter chips
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderAll();
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getFilteredAccounts() {
  return accounts.filter(acc => {
    // Filter
    if (activeFilter !== 'all' && acc.status !== activeFilter) return false;
    // Search
    if (searchQuery && !acc.email.toLowerCase().includes(searchQuery)) return false;
    return true;
  });
}

function updateStats() {
  $('#total-count').textContent = accounts.length;
  $('#watching-count').textContent = accounts.filter(a => a.status === 'watching').length;
  $('#codes-count').textContent = accounts.filter(a => a.status === 'code_found').length;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function showToast(text, type = 'success') {
  toastEl.textContent = text;
  toastEl.className = `toast ${type} show`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3000);
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
