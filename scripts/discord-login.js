// Easy Discord login for CozyBrowsin agents.
//
// Usage (in CozyBrowsin DevTools console on any discord.com page, or about:blank):
// 1. Copy your Discord token to the clipboard (from Network tab Authorization header, or from your agent).
// 2. Paste this entire file's contents into the console and run, or just run the login() call after setting the token.
//
// Or from an agent that can evaluate JS in the page:
//   login("your_token_here")
//
// The session (cookies + localStorage) is persisted by Electron's default profile,
// so subsequent launches of CozyBrowsin will already be logged in.

function login(token) {
  if (!token || typeof token !== 'string') {
    console.error('Provide a token string');
    return;
  }
  // Discord expects the token quoted in localStorage
  const quoted = '"' + token.replace(/"/g, '') + '"';
  const interval = setInterval(() => {
    try {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      iframe.contentWindow.localStorage.token = quoted;
      iframe.remove();
    } catch (e) {}
  }, 50);
  setTimeout(() => {
    clearInterval(interval);
    location.reload();
  }, 1500);
  console.log('Token injection started; page will reload shortly.');
}

// Optional: if you already have the token in a global or from clipboard via agent
// login(window.DISCORD_TOKEN || prompt('Paste Discord token:'));

console.log('Discord login helper loaded. Call login("YOUR_TOKEN") to sign in.');
