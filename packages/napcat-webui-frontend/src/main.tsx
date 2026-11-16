import ReactDOM from 'react-dom/client';
import 'react-photo-view/dist/react-photo-view.css';
import { BrowserRouter } from 'react-router-dom';

import App from '@/App.tsx';
import { Provider } from '@/provider.tsx';
import '@/styles/globals.css';

import key from './const/key';
import WebUIManager from './controllers/webui_manager';
import { initFont, loadTheme } from './utils/theme';
import { resourceRecoveryMessage } from './utils/resource-recovery';

const token = localStorage.getItem(key.token);
const theme = localStorage.getItem(key.theme);

// 兼容 useLocalStorage
if (token && !token.startsWith('"')) {
  localStorage.setItem(key.token, JSON.stringify(token));
}
if (theme && !theme.startsWith('"')) {
  localStorage.setItem(key.theme, JSON.stringify(theme));
}

// Anonymous visitors must be able to render the login page without issuing an
// unauthenticated auth/check promise. Existing credentials are still validated;
// the request interceptor retains its normal Unauthorized invalidation behavior.
if (token && token !== '""') {
  void WebUIManager.checkWebUiLogined().catch(() => {
    // Expired credentials / an unavailable backend are expected startup states.
    // AuthChecker and the authenticated API pages provide the recovery UI.
  });
}

// Vite fires this when a lazily imported chunk cannot be fetched (typically after a
// rebuild left the browser holding an old index). Prevent the unhandled rejection
// and surface an actionable reload prompt instead of a blank page.
// The event only fires for failed chunk preloads, so no string matching is needed.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  const online = navigator.onLine;
  const message = `${resourceRecoveryMessage(online)}\n\n刷新后未保存的表单会丢失，管理登录凭据会保留。`;
  if (online && window.confirm(message + '\n\n现在刷新页面？')) window.location.reload();
});

loadTheme();
initFont();

ReactDOM.createRoot(document.getElementById('root')!).render(
  // <React.StrictMode>
  <BrowserRouter basename='/webui/'>
    <Provider>
      <App />
    </Provider>
  </BrowserRouter>
  // </React.StrictMode>
);

if (!import.meta.env.DEV) {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const baseUrl = import.meta.env.BASE_URL;
      const swUrl = `${baseUrl}sw.js`;
      navigator.serviceWorker.register(swUrl, { scope: baseUrl })
        .then((registration) => {
          console.log('SW registered: ', registration);
        })
        .catch((registrationError) => {
          console.log('SW registration failed: ', registrationError);
        });
    });
  }
}
