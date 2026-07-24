// Non-blocking transient notifications.
export function showToast(message, { error = false, ms = 2600 } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
