/**
 * 配对页面 HTML
 */

export function renderPairingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw Control Center - Pair Device</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(10px);
    }
    .logo {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo h1 {
      font-size: 24px;
      color: #ff6b35;
    }
    .logo p {
      color: #888;
      font-size: 14px;
      margin-top: 8px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #ccc;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #ff6b35;
    }
    input::placeholder {
      color: #666;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(255, 107, 53, 0.4);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .error {
      background: rgba(255, 59, 48, 0.1);
      border: 1px solid rgba(255, 59, 48, 0.3);
      color: #ff3b30;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .success {
      background: rgba(52, 199, 89, 0.1);
      border: 1px solid rgba(52, 199, 89, 0.3);
      color: #34c759;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .token-display {
      background: rgba(255, 255, 255, 0.1);
      padding: 16px;
      border-radius: 8px;
      margin-top: 20px;
      word-break: break-all;
      font-family: monospace;
      font-size: 14px;
      display: none;
    }
    .token-display strong {
      color: #ff6b35;
    }
    .divider {
      text-align: center;
      margin: 24px 0;
      color: #666;
      position: relative;
    }
    .divider::before,
    .divider::after {
      content: '';
      position: absolute;
      top: 50%;
      width: 40%;
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
    }
    .divider::before { left: 0; }
    .divider::after { right: 0; }
    .alt-option {
      text-align: center;
      color: #888;
      font-size: 14px;
    }
    .alt-option a {
      color: #ff6b35;
      text-decoration: none;
    }
    .alt-option a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>🦞 OpenClaw Control Center</h1>
      <p>Pair your device to access the control panel</p>
    </div>
    
    <div class="error" id="error"></div>
    <div class="success" id="success"></div>
    
    <form id="pairForm">
      <div class="form-group">
        <label for="code">Pairing Code</label>
        <input type="text" id="code" placeholder="Enter 6-digit code" maxlength="6" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="deviceName">Device Name</label>
        <input type="text" id="deviceName" placeholder="e.g., MacBook, iPhone" value="">
      </div>
      <button type="submit" id="submitBtn">Pair Device</button>
    </form>
    
    <div class="token-display" id="tokenDisplay">
      <strong>Access Token:</strong><br>
      <span id="tokenValue"></span>
      <br><br>
      <small style="color: #888;">Save this token securely. You'll need it to access Control Center.</small>
    </div>
    
    <div class="divider">or</div>
    
    <div class="alt-option">
      Have an access token? <a href="#" onclick="showTokenLogin()">Login with token</a>
    </div>
  </div>

  <script>
    const form = document.getElementById('pairForm');
    const errorDiv = document.getElementById('error');
    const successDiv = document.getElementById('success');
    const tokenDisplay = document.getElementById('tokenDisplay');
    const tokenValue = document.getElementById('tokenValue');
    const submitBtn = document.getElementById('submitBtn');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const code = document.getElementById('code').value.trim().toUpperCase();
      const deviceName = document.getElementById('deviceName').value.trim() || 'Unknown Device';
      
      if (code.length !== 6) {
        showError('Please enter a valid 6-digit pairing code');
        return;
      }
      
      submitBtn.disabled = true;
      submitBtn.textContent = 'Pairing...';
      hideMessages();
      
      try {
        const response = await fetch('/api/pairing/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceName })
        });
        
        const data = await response.json();
        
        if (data.success) {
          showSuccess('Device paired successfully!');
          tokenValue.textContent = data.accessToken;
          tokenDisplay.style.display = 'block';
          
          // Store token in cookie
          document.cookie = 'access_token=' + data.accessToken + '; path=/; max-age=31536000';
          
          // Redirect after 2 seconds
          setTimeout(() => {
            window.location.href = '/?section=overview';
          }, 2000);
        } else {
          showError(data.error || 'Pairing failed');
        }
      } catch (err) {
        showError('Network error. Please try again.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Pair Device';
      }
    });
    
    function showError(msg) {
      errorDiv.textContent = msg;
      errorDiv.style.display = 'block';
      successDiv.style.display = 'none';
    }
    
    function showSuccess(msg) {
      successDiv.textContent = msg;
      successDiv.style.display = 'block';
      errorDiv.style.display = 'none';
    }
    
    function hideMessages() {
      errorDiv.style.display = 'none';
      successDiv.style.display = 'none';
    }
    
    function showTokenLogin() {
      const token = prompt('Enter your access token:');
      if (token) {
        document.cookie = 'access_token=' + token + '; path=/; max-age=31536000';
        window.location.reload();
      }
    }
  </script>
</body>
</html>`;
}

export function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw Control Center - Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(10px);
    }
    .logo {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo h1 {
      font-size: 24px;
      color: #ff6b35;
    }
    .logo p {
      color: #888;
      font-size: 14px;
      margin-top: 8px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #ccc;
      font-size: 14px;
    }
    input {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #ff6b35;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(255, 107, 53, 0.4);
    }
    .error {
      background: rgba(255, 59, 48, 0.1);
      border: 1px solid rgba(255, 59, 48, 0.3);
      color: #ff3b30;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      display: none;
    }
    .divider {
      text-align: center;
      margin: 24px 0;
      color: #666;
      position: relative;
    }
    .divider::before,
    .divider::after {
      content: '';
      position: absolute;
      top: 50%;
      width: 40%;
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
    }
    .divider::before { left: 0; }
    .divider::after { right: 0; }
    .alt-option {
      text-align: center;
      color: #888;
      font-size: 14px;
    }
    .alt-option a {
      color: #ff6b35;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>🦞 OpenClaw Control Center</h1>
      <p>Enter your access token to continue</p>
    </div>
    
    <div class="error" id="error"></div>
    
    <form id="loginForm">
      <div class="form-group">
        <label for="token">Access Token</label>
        <input type="password" id="token" placeholder="Enter your access token" autocomplete="off">
      </div>
      <button type="submit">Login</button>
    </form>
    
    <div class="divider">or</div>
    
    <div class="alt-option">
      Need to pair a new device? <a href="/pair">Pair device</a>
    </div>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    const errorDiv = document.getElementById('error');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const token = document.getElementById('token').value.trim();
      
      if (!token) {
        showError('Please enter your access token');
        return;
      }
      
      // Store token in cookie and reload
      document.cookie = 'access_token=' + token + '; path=/; max-age=31536000';
      
      // Verify token by making a request
      try {
        const response = await fetch('/api/devices');
        if (response.ok) {
          window.location.href = '/?section=overview';
        } else {
          showError('Invalid access token');
          document.cookie = 'access_token=; path=/; max-age=0';
        }
      } catch {
        showError('Network error. Please try again.');
      }
    });
    
    function showError(msg) {
      errorDiv.textContent = msg;
      errorDiv.style.display = 'block';
    }
  </script>
</body>
</html>`;
}
