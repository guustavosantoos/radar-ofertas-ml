console.log("[SIDE_PANEL_V3] ================== SIDEPANEL.JS FOI CARREGADO ==================");
document.addEventListener('DOMContentLoaded', async () => {
  const loginSection = document.getElementById('login-section');
  const mainContent = document.getElementById('main-content');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const loginBtn = document.getElementById('login-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const userName = document.getElementById('user-name');
  const userPlan = document.getElementById('user-plan');
  const connectionStatus = document.getElementById('connection-status');

  const noProduct = document.getElementById('no-product');
  const productCard = document.getElementById('product-card');
  const productImage = document.getElementById('product-image');
  const productName = document.getElementById('product-name');
  const productPrice = document.getElementById('product-price');
  const productOriginalPrice = document.getElementById('product-original-price');
  const productDiscount = document.getElementById('product-discount');
  const productSeller = document.getElementById('product-seller');
  const productShipping = document.getElementById('product-shipping');
  const productRating = document.getElementById('product-rating');
  const productSales = document.getElementById('product-sales');
  const productBestSeller = document.getElementById('product-bestseller');
  const generateLinkBtn = document.getElementById('generate-link-btn');
  const affiliateLinkResult = document.getElementById('affiliate-link-result');
  const affiliateLinkInput = document.getElementById('affiliate-link-input');
  const copyLinkBtn = document.getElementById('copy-link-btn');
  const sendToApiBtn = document.getElementById('send-to-api-btn');
  const copyWhatsappBtn = document.getElementById('copy-whatsapp-btn');

  // Automation control DOM refs removed — only schedule UI remains

  // Keywords DOM refs removed — keywords now used only in schedule UI

  const apiUrlInput = document.getElementById('api-url-input');
  const saveApiUrlBtn = document.getElementById('save-api-url');
  const filterFreeShipping = document.getElementById('filter-free-shipping');
  const filterMinRating = document.getElementById('filter-min-rating');
  const filterMinDiscount = document.getElementById('filter-min-discount');
  const filterMaxPrice = document.getElementById('filter-max-price');
  const saveFiltersBtn = document.getElementById('save-filters-btn');

  const envBadge = document.getElementById('env-badge');
  const envSelectorGroup = document.getElementById('env-selector-group');
  const envBtnProd = document.getElementById('env-btn-prod');
  const envBtnDev = document.getElementById('env-btn-dev');
  const envHint = document.getElementById('env-hint');

  const settingsToggleLogin = document.getElementById('settings-toggle-login');
  const apiUrlConfigLogin = document.getElementById('api-url-config-login');
  const apiUrlInputLogin = document.getElementById('api-url-input-login');
  const saveApiUrlLogin = document.getElementById('save-api-url-login');

  const listingCard = document.getElementById('listing-card');
  const listingCount = document.getElementById('listing-count');
  const listingSource = document.getElementById('listing-source');
  const listingItems = document.getElementById('listing-items');
  const sendAllToApiBtn = document.getElementById('send-all-to-api-btn');
  const sendSelectedBtn = document.getElementById('send-selected-to-api-btn');
  const selectAllBtn = document.getElementById('select-all-btn');
  const sendAllProgress = document.getElementById('send-all-progress');
  const sendAllProgressFill = document.getElementById('send-all-progress-fill');
  const sendAllProgressText = document.getElementById('send-all-progress-text');

  let currentProduct = null;
  let currentListingProducts = null;
  let currentPlatform = 'ml';

  console.log('[SidePanel] Sidepanel.js carregado - v2.1 (multi-plataforma ML + Shopee)');

  console.log('[SidePanel] Sidepanel.js carregado - v2.0 (com link de afiliado obrigatório)');

  /**
   * Ativa uma aba programaticamente.
   *
   * Dispara o `click` do botão em vez de mexer nas classes na mão: os listeners de
   * hidratação de cada aba (loadListasTab etc.) estão pendurados no clique, então
   * trocar só o `.active` mostraria um painel vazio.
   */
  function switchTab(tabName) {
    const button = document.querySelector(`.tab-button[data-tab="${tabName}"]`);
    if (!button) return false;
    if (button.classList.contains('active')) return true;
    button.click();
    return true;
  }

  // Setup tab navigation
  function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const tabName = button.dataset.tab;

        // Remove active class from all buttons and panes
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabPanes.forEach(pane => pane.classList.remove('active'));

        // Add active class to clicked button and corresponding pane
        button.classList.add('active');
        document.getElementById(`tab-${tabName}`).classList.add('active');
      });
    });
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response);
      });
    });
  }

  // Load user's custom categories into select dropdown (per-platform cache)
  let _shopeeCategoriesCache = null;
  let _shopeeCategoriesCacheTime = 0;
  let _mlCategoriesCache = null;
  let _mlCategoriesCacheTime = 0;
  let _amazonCategoriesCache = null;
  let _amazonCategoriesCacheTime = 0;
  const CATEGORIES_CACHE_TTL = 60000; // 1 min

  // Kept for backward compatibility — loads Shopee categories (listing tab)
  async function loadCustomCategorySuggestions() {
    const select = document.getElementById('categorySelect');
    if (!select) return;

    const now = Date.now();
    if (_shopeeCategoriesCache && (now - _shopeeCategoriesCacheTime) < CATEGORIES_CACHE_TTL) {
      populateCategorySelect(select, _shopeeCategoriesCache);
      return;
    }

    try {
      const result = await sendMessage({ action: 'getCustomCategories' });
      if (result?.success && Array.isArray(result.data)) {
        _shopeeCategoriesCache = result.data;
        _shopeeCategoriesCacheTime = now;
        populateCategorySelect(select, result.data);
      }
    } catch (e) {
      console.warn('[SidePanel] Erro ao carregar categorias Shopee:', e);
    }
  }

  async function loadMlCategorySuggestions() {
    const select = document.getElementById('categorySelect');
    if (!select) return;

    const now = Date.now();
    if (_mlCategoriesCache && (now - _mlCategoriesCacheTime) < CATEGORIES_CACHE_TTL) {
      populateCategorySelect(select, _mlCategoriesCache);
      return;
    }

    try {
      const result = await sendMessage({ action: 'getMlCategories' });
      if (result?.success && Array.isArray(result.data)) {
        _mlCategoriesCache = result.data;
        _mlCategoriesCacheTime = now;
        populateCategorySelect(select, result.data);
      }
    } catch (e) {
      console.warn('[SidePanel] Erro ao carregar categorias ML:', e);
    }
  }

  async function loadAmazonCategorySuggestions() {
    const select = document.getElementById('categorySelect');
    if (!select) return;

    const now = Date.now();
    if (_amazonCategoriesCache && (now - _amazonCategoriesCacheTime) < CATEGORIES_CACHE_TTL) {
      populateCategorySelect(select, _amazonCategoriesCache);
      return;
    }

    try {
      const result = await sendMessage({ action: 'getAmazonCategories' });
      if (result?.success && Array.isArray(result.data)) {
        _amazonCategoriesCache = result.data;
        _amazonCategoriesCacheTime = now;
        populateCategorySelect(select, result.data);
      }
    } catch (e) {
      console.warn('[SidePanel] Erro ao carregar categorias Amazon:', e);
    }
  }

  function populateCategorySelect(select, categories) {
    // Preserve current selection
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Selecione ou crie nova --</option>';
    var sorted = categories.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    sorted.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = `${cat.name} (${cat.count})`;
      select.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ Nova categoria...';
    select.appendChild(newOpt);
    // Restore selection if it still exists
    if (currentVal && currentVal !== '__new__') {
      select.value = currentVal;
    }
  }

  function invalidateCategoriesCache() {
    _shopeeCategoriesCache = null;
    _shopeeCategoriesCacheTime = 0;
    _mlCategoriesCache = null;
    _mlCategoriesCacheTime = 0;
    _amazonCategoriesCache = null;
    _amazonCategoriesCacheTime = 0;
  }

  // Wire up category select ↔ text input (reusable for any select/input pair)
  function wireUpCategorySelect(selectId, inputId) {
    const select = document.getElementById(selectId);
    const input = document.getElementById(inputId);
    if (!select || !input) return;

    select.addEventListener('change', function() {
      if (select.value === '__new__') {
        input.classList.remove('hidden');
        input.value = '';
        input.focus();
      } else {
        input.classList.add('hidden');
        input.value = select.value;
      }
    });
  }

  // Helper: read category from a select/input pair
  function readCategoryFromPair(selectId, inputId) {
    var select = document.getElementById(selectId);
    var input = document.getElementById(inputId);
    if (select && select.value && select.value !== '__new__') {
      return select.value.trim();
    }
    return input ? input.value.trim() : '';
  }

  // Setup category selectors (listing + single product + save-list)
  wireUpCategorySelect('categorySelect', 'categoryNameInput');
  wireUpCategorySelect('singleProductCategorySelect', 'singleProductCategoryInput');
  wireUpCategorySelect('saveListCategorySelect', 'saveListCategoryInput');

  // Load categories into a platform-aware select
  async function loadCategoriesIntoSelect(selectId, platform) {
    var select = document.getElementById(selectId);
    if (!select) return;
    if (platform === 'ml') {
      await loadMlCategorySuggestions();
      if (_mlCategoriesCache) populateCategorySelect(select, _mlCategoriesCache);
    } else if (platform === 'amazon') {
      await loadAmazonCategorySuggestions();
      if (_amazonCategoriesCache) populateCategorySelect(select, _amazonCategoriesCache);
    } else {
      await loadCustomCategorySuggestions();
      if (_shopeeCategoriesCache) populateCategorySelect(select, _shopeeCategoriesCache);
    }
  }

  // Load categories into single product select (platform-aware)
  async function loadSingleProductCategories(platform) {
    await loadCategoriesIntoSelect('singleProductCategorySelect', platform);
  }

  // Load categories into save-list select (platform-aware)
  async function loadSaveListCategories(platform) {
    await loadCategoriesIntoSelect('saveListCategorySelect', platform);
  }

  function formatPrice(cents) {
    if (!cents) return '';
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
  }

  function updateConnectionStatus(connected) {
    const dot = connectionStatus.querySelector('.status-dot');
    const text = connectionStatus.querySelector('.status-text');
    dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
    text.textContent = connected ? 'Conectado' : 'Desconectado';
  }

  async function checkAuth() {
    try {
      const autoLoginResult = await sendMessage({ action: 'autoLogin' });
      if (autoLoginResult && autoLoginResult.success) {
        console.log('[SidePanel] Auto-login bem-sucedido');
        showMainContent(autoLoginResult.data);
        return;
      }
    } catch (error) {
      console.log('[SidePanel] Auto-login não disponível:', error);
    }

    const info = await sendMessage({ action: 'getAuthInfo' });
    if (info && info.isLoggedIn) {
      showMainContent(info);
    } else {
      showLogin();
      showLoginPrompt();
    }
  }

  function showLogin(message = '') {
    loginSection.classList.remove('hidden');
    mainContent.classList.add('hidden');
    updateConnectionStatus(false);
    if (message) {
      loginError.textContent = message;
      loginError.style.color = '#FFF';
    }
  }

  function showLoginPrompt() {
    loginError.textContent = '';
  }

  function updateEnvBadge(env) {
    envBadge.textContent = env === 'dev' ? 'DEV' : 'PROD';
    envBadge.className = `env-badge env-${env}`;
  }

  function updateEnvSelector(env) {
    envBtnProd.classList.toggle('active', env === 'prod');
    envBtnDev.classList.toggle('active', env === 'dev');
    envHint.textContent = env === 'dev' ? 'Conectado ao servidor de desenvolvimento' : '';
  }

  function showMainContent(info) {
    loginSection.classList.add('hidden');
    mainContent.classList.remove('hidden');
    userName.textContent = info.userName || 'Usuário';
    userPlan.textContent = info.plan || 'trial';
    userPlan.className = `badge ${info.plan || 'trial'}`;
    updateConnectionStatus(true);

    const isAdmin = info.plan === 'admin';
    const apiUrlGroup = document.getElementById('api-url-group');
    const loginFooterAdmin = document.getElementById('login-footer-admin');
    const configTabButton = document.querySelector('.tab-button[data-tab="configuracoes"]');
    if (isAdmin) {
      envBadge.classList.remove('hidden');
      envSelectorGroup.classList.remove('hidden');
      if (apiUrlGroup) apiUrlGroup.classList.remove('hidden');
      if (loginFooterAdmin) loginFooterAdmin.classList.remove('hidden');
      if (configTabButton) configTabButton.classList.remove('hidden');
    } else {
      envBadge.classList.add('hidden');
      envSelectorGroup.classList.add('hidden');
      if (apiUrlGroup) apiUrlGroup.classList.add('hidden');
      if (loginFooterAdmin) loginFooterAdmin.classList.add('hidden');
      if (configTabButton) configTabButton.classList.add('hidden');
    }

    loadConfig();
    requestExtraction();
    checkMlLoginStatus();
    loadQueueState();
    checkExtensionVersion();
    // Categories are loaded on-demand when product/listing is displayed (platform-aware)
  }

  async function checkExtensionVersion() {
    try {
      const currentVersion = chrome.runtime.getManifest().version;
      console.log('[SidePanel] Versão instalada:', currentVersion);

      // Update version label in settings tab and below user name (sempre visível, mesmo
      // sem a aba Config — esta só aparece para plan=admin).
      const versionLabel = document.getElementById('extension-version-label');
      if (versionLabel) versionLabel.textContent = 'v' + currentVersion;
      const userVersionLabel = document.getElementById('user-version-label');
      if (userVersionLabel) userVersionLabel.textContent = 'v' + currentVersion;

      const config = await chrome.storage.local.get(['apiBaseUrl', 'apiEnvironment']);
      const env = config.apiEnvironment || 'prod';
      const ENVIRONMENTS = {
        prod: 'https://radar-ofertas-ml-api.vercel.app',
        dev: 'http://localhost:3000',
      };
      const baseUrl = config.apiBaseUrl || ENVIRONMENTS[env] || ENVIRONMENTS['prod'];

      const resp = await fetch(`${baseUrl}/api/extension/version`);
      if (!resp.ok) return;

      const data = await resp.json();
      const latestVersion = data.version;
      const downloadUrl = data.downloadUrl;

      console.log('[SidePanel] Versão mais recente:', latestVersion);

      if (latestVersion && currentVersion !== latestVersion && isVersionOlder(currentVersion, latestVersion)) {
        const banner = document.getElementById('update-banner');
        const bannerText = document.getElementById('update-banner-text');
        const bannerLink = document.getElementById('update-banner-link');

        bannerText.textContent = `Sua versão: ${currentVersion} → Nova versão: ${latestVersion}`;

        if (downloadUrl) {
          bannerLink.href = downloadUrl;
          bannerLink.style.display = 'inline-block';
        } else {
          bannerLink.style.display = 'none';
        }

        banner.classList.remove('hidden');
      }
    } catch (err) {
      console.warn('[SidePanel] Erro ao verificar versão:', err);
    }
  }

  function isVersionOlder(current, latest) {
    const c = current.split('.').map(Number);
    const l = latest.split('.').map(Number);
    for (let i = 0; i < Math.max(c.length, l.length); i++) {
      const cv = c[i] || 0;
      const lv = l[i] || 0;
      if (cv < lv) return true;
      if (cv > lv) return false;
    }
    return false;
  }

  async function checkMlLoginStatus() {
    const mlNotLogged = document.getElementById('ml-not-logged');
    const mlLoginCheck = document.getElementById('ml-login-check');
    if (!mlNotLogged || !mlLoginCheck) return;

    const result = await sendMessage({ action: 'checkMlLogin' });
    if (result && result.loggedIn) {
      mlLoginCheck.classList.add('hidden');
    } else {
      mlLoginCheck.classList.remove('hidden');
      mlNotLogged.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = 'Mercado Livre:';
      mlNotLogged.appendChild(strong);
      mlNotLogged.appendChild(document.createTextNode(' ' + (result?.error || 'Faça login na sua conta de afiliado do ML.')));
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Entrando...';

    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    const result = await sendMessage({ action: 'login', email, password });

    loginBtn.disabled = false;
    loginBtn.textContent = 'Entrar';

    if (result && result.success) {
      showMainContent(result.data);
    } else {
      const errorMsg = result?.error || 'Erro ao fazer login';
      console.error('[SidePanel] Login error:', errorMsg);
      loginError.textContent = errorMsg;
      loginError.style.whiteSpace = 'pre-wrap';
      loginError.style.wordBreak = 'break-word';
      loginError.style.fontSize = '12px';
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await sendMessage({ action: 'logout' });
    showLogin();
  });

  settingsToggleLogin.addEventListener('click', () => {
    apiUrlConfigLogin.classList.toggle('hidden');
  });

  saveApiUrlLogin.addEventListener('click', async () => {
    const url = apiUrlInputLogin.value.trim();
    if (url) {
      await sendMessage({ action: 'setApiBaseUrl', url });
      apiUrlConfigLogin.classList.add('hidden');
    }
  });

  function detectPlatformFromData(data) {
    if (!data) return 'ml';
    var d = Array.isArray(data) ? data[0] : data;
    if (!d) return 'ml';
    // Check explicit platform/marketplace fields
    if (d.platform === 'shopee' || d.marketplace === 'shopee') return 'shopee';
    if (d.platform === 'amazon' || d.marketplace === 'amazon' || d.asin) return 'amazon';
    // Check URL-based detection as fallback
    var url = d.productLink || d.productUrl || '';
    if (url.includes('amazon.com.br') || url.includes('amzn.to')) return 'amazon';
    if (url.includes('shopee.com.br')) return 'shopee';
    // Check array items
    if (Array.isArray(data) && data.length > 0) {
      var first = data[0];
      if (first.platform === 'shopee') return 'shopee';
      if (first.platform === 'amazon' || first.asin) return 'amazon';
      var firstUrl = first.productLink || first.productUrl || '';
      if (firstUrl.includes('amazon.com.br')) return 'amazon';
      if (firstUrl.includes('shopee.com.br')) return 'shopee';
    }
    return 'ml';
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeImageUrl(url) {
    if (!url) return '';
    try {
      var u = new URL(url);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? escapeHtml(url) : '';
    } catch (e) { return ''; }
  }

  function getPlatformBadge(platform) {
    if (platform === 'shopee') return '<span class="platform-badge shopee-badge" style="background:#EE4D2D;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;">Shopee</span>';
    if (platform === 'amazon') return '<span class="platform-badge amz-badge" style="background:#FF9900;color:#111;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;">Amazon</span>';
    return '<span class="platform-badge ml-badge" style="background:#FFE600;color:#333;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;">ML</span>';
  }

  function getSellerDisplay(data) {
    var name = data.sellerName || data.seller || null;
    return name ? `Vendedor: ${name}` : '';
  }

  // Normalize rating to a 0-5 decimal for display (handles all platforms)
  // Amazon ratingStar: 0-50 (4.7=47), ML ratingStar: 0-500 (4.7=470), Shopee rating: string "4.7"
  function normalizeRatingToDecimal(data) {
    if (data.ratingStar) {
      var platform = detectPlatformFromData(data);
      var divisor = platform === 'amazon' ? 10 : 100;
      return (data.ratingStar / divisor).toFixed(1);
    }
    if (data.rating) {
      var val = parseFloat(data.rating);
      if (!isNaN(val)) return val.toFixed(1);
    }
    return null;
  }

  function formatRatingDisplay(data) {
    return normalizeRatingToDecimal(data) || '';
  }

  function getRatingDisplay(data) {
    var decimal = normalizeRatingToDecimal(data);
    return decimal ? `⭐ ${decimal}` : '';
  }

  // ===== Tag de afiliado Amazon =====
  //
  // Com o link longo (`dp/{ASIN}?tag={TAG}`) a tag é o que decide para QUAL loja vai a
  // comissão. Mostrá-la é o que permite conferir isso ANTES de salvar um lote — no
  // formato antigo (amzn.to) ela ficava invisível dentro do redirect, e foi assim que a
  // tag "status" passou semanas cunhando link para a conta errada.
  async function atualizarBarraTagAmazon(forceRefresh) {
    const barra = document.getElementById('amz-tag-bar');
    const valor = document.getElementById('amz-tag-value');
    const botao = document.getElementById('amz-tag-refresh');
    if (!barra || !valor) return;

    if (currentPlatform !== 'amazon') {
      barra.classList.add('hidden');
      return;
    }
    barra.classList.remove('hidden');
    if (botao) botao.disabled = true;
    if (forceRefresh) valor.textContent = 'lendo...';

    // `somenteCache` quando é só para EXIBIR: sem ele, abrir um produto na tela dispararia
    // a leitura na Amazon — uma aba em segundo plano e até ~17 s de espera por produto.
    // A leitura de verdade é do botão "Atualizar" (e do início de cada lote de envio).
    const r = await sendMessage({
      action: 'getAmazonTag',
      forceRefresh: !!forceRefresh,
      somenteCache: !forceRefresh,
    }).catch(function (e) {
      return { success: false, error: (e && e.message) || 'falha ao consultar a tag' };
    });
    if (botao) botao.disabled = false;

    if (r && r.success && r.tag) {
      valor.textContent = r.tag;
      valor.classList.remove('amz-tag-erro');
      valor.title = r.deCache ? 'tag em cache (revalidada a cada lote)' : 'tag lida agora no Associados';
    } else if (r && r.reason === 'sem-cache') {
      // Ainda não lida nesta sessão — não é erro.
      valor.textContent = 'clique em Atualizar para ler';
      valor.classList.remove('amz-tag-erro');
      valor.title = '';
    } else {
      // Fail-closed: sem tag NÃO se gera link. Dizer isso aqui evita que o usuário
      // descubra pelo contador de erros da fila.
      valor.textContent = (r && r.error) || 'não foi possível ler a tag — faça login no Associados';
      valor.classList.add('amz-tag-erro');
      valor.title = '';
    }
  }

  const amzTagRefreshBtn = document.getElementById('amz-tag-refresh');
  if (amzTagRefreshBtn) {
    amzTagRefreshBtn.addEventListener('click', () => atualizarBarraTagAmazon(true));
  }

  // Contagem de avaliações com separador de milhar ("1400" → "1.400"). Antes ia
  // crua para a tela; agora que "1,4 mil" da Amazon é lido como 1400 (ver
  // amazon-reviews-utils.js), "(1400)" ficaria pior de ler que o site.
  function formatReviewsDisplay(count) {
    var n = parseInt(count, 10);
    if (!isFinite(n) || n <= 0) return '';
    try {
      return n.toLocaleString('pt-BR');
    } catch (e) {
      return String(n);
    }
  }

  /** 10000 → "+10 mil vendidos"; 250 → "250 vendidos" (formato do próprio ML). */
  function formatSalesDisplay(qty) {
    var n = parseInt(qty, 10);
    if (!isFinite(n) || n <= 0) return '';
    if (n >= 1000000) return '+' + Math.floor(n / 1000000) + ' mi vendidos';
    if (n >= 1000) return '+' + Math.floor(n / 1000) + ' mil vendidos';
    return n + ' vendidos';
  }

  function displayProduct(data) {
    // Validate: must have a name AND a price or item ID to be a real product
    // This prevents homepage/profile data (avatars, site metadata, promo banners) from showing as products
    var hasRealId = data && (
      data.itemId || data.platformItemId || data.mlItemId || data.asin
    );
    var hasProductUrl = data && data.productUrl && (
      data.productUrl.includes('-i.') || data.productUrl.includes('/dp/') || data.productUrl.includes('MLB')
    );
    var isValidProduct = data && data.productName && (hasRealId || hasProductUrl || (data.price && data.price > 0));

    // Reject if image is an animated GIF (promo banner, not a real product photo)
    if (isValidProduct && data.imageUrl && /\.gif(\?|$)/i.test(data.imageUrl)) {
      isValidProduct = false;
    }

    if (!isValidProduct) {
      noProduct.classList.remove('hidden');
      productCard.classList.add('hidden');
      listingCard.classList.add('hidden');
      var collectEl = document.getElementById('collect-action');
      if (collectEl) collectEl.classList.add('hidden');
      currentProduct = null;
      currentListingProducts = null;
      return;
    }

    currentProduct = data;
    currentListingProducts = null;
    currentPlatform = detectPlatformFromData(data);
    atualizarBarraTagAmazon(false).catch(function () {});
    noProduct.classList.add('hidden');
    productCard.classList.remove('hidden');
    listingCard.classList.add('hidden');
    const collectActionEl = document.getElementById('collect-action');
    if (collectActionEl) collectActionEl.classList.add('hidden');

    productName.textContent = data.productName + ' ';
    productName.insertAdjacentHTML('beforeend', getPlatformBadge(currentPlatform));
    productPrice.textContent = formatPrice(data.price);

    if (data.originalPrice && data.originalPrice > data.price) {
      productOriginalPrice.textContent = formatPrice(data.originalPrice);
      productOriginalPrice.classList.remove('hidden');
    } else {
      productOriginalPrice.classList.add('hidden');
    }

    if (data.discountPercent) {
      productDiscount.textContent = `-${data.discountPercent}%`;
      productDiscount.classList.remove('hidden');
    } else {
      productDiscount.classList.add('hidden');
    }

    if (data.imageUrl) {
      productImage.src = data.imageUrl;
      productImage.classList.remove('hidden');
    } else {
      productImage.classList.add('hidden');
    }

    productSeller.textContent = getSellerDisplay(data);
    productShipping.textContent = data.freeShipping ? '🚚 Frete Grátis' : '';

    // Avaliações, vendas e selo MAIS VENDIDO: a PDP do ML expõe os três e eles
    // só apareciam quando o produto vinha do grid. textContent sempre — nunca
    // innerHTML — porque o conteúdo vem raspado da página.
    var ratingText = getRatingDisplay(data);
    if (ratingText && data.reviewsCount) ratingText += ' (' + formatReviewsDisplay(data.reviewsCount) + ')';
    productRating.textContent = ratingText;

    if (productSales) {
      // Emoji DENTRO do guard: salesQuantity truthy porém não-numérico (string de
      // outro marketplace) deixaria um "🔥 " órfão — que não é :empty e por isso o
      // CSS não esconderia.
      var salesText = formatSalesDisplay(data.salesQuantity);
      productSales.textContent = salesText ? '🔥 ' + salesText : '';
    }
    if (productBestSeller) {
      productBestSeller.textContent = data.isBestSeller
        ? '🏆 MAIS VENDIDO' + (data.bestSellerRank ? ' · ' + data.bestSellerRank : '')
        : '';
    }

    // Show category selector for single product (all platforms)
    var singleCatGroup = document.getElementById('single-product-category-group');
    if (singleCatGroup) {
      singleCatGroup.style.display = 'block';
      loadSingleProductCategories(currentPlatform);
    }

    // All platforms: show only "Salvar Produto" button (hide others)
    generateLinkBtn.textContent = 'Salvar Produto';
    generateLinkBtn.title = 'Link de afiliado será gerado automaticamente';
    sendToApiBtn.classList.add('hidden');
    copyWhatsappBtn.classList.add('hidden');

    affiliateLinkResult.classList.add('hidden');
    affiliateLinkInput.value = '';
  }

  async function requestExtraction() {
    const result = await sendMessage({ action: 'extractOffer' });
    if (result && result.success && result.data) {
      if (Array.isArray(result.data)) {
        displayListing(result.data, result.source);
        displaySaveListProducts(result.data);
      } else {
        displayProduct(result.data);
      }
    } else {
      // No product found (homepage, unsupported page, etc.) — show empty state
      noProduct.classList.remove('hidden');
      productCard.classList.add('hidden');
      listingCard.classList.add('hidden');
      var collectEl = document.getElementById('collect-action');
      if (collectEl) collectEl.classList.add('hidden');
      currentProduct = null;
      currentListingProducts = null;
    }
  }

  function displayListing(products, source) {
    // Capture currently checked items BEFORE updating state
    var previouslyChecked = new Set();
    if (currentListingProducts) {
      document.querySelectorAll('.product-checkbox:checked').forEach(function(cb) {
        var idx = parseInt(cb.dataset.index);
        var p = currentListingProducts[idx];
        if (p) {
          var key = p.asin || p.mlItemId || p.platformItemId || '';
          if (key) previouslyChecked.add(key);
        }
      });
    }

    currentListingProducts = products;
    currentProduct = null;
    currentPlatform = detectPlatformFromData(products);
    atualizarBarraTagAmazon(false).catch(function () {});

    // Load platform-specific categories into the listing dropdown immediately
    if (currentPlatform === 'ml') {
      loadMlCategorySuggestions();
    } else if (currentPlatform === 'amazon') {
      loadAmazonCategorySuggestions();
    } else {
      loadCustomCategorySuggestions();
    }

    noProduct.classList.add('hidden');
    productCard.classList.add('hidden');
    listingCard.classList.remove('hidden');

    listingCount.textContent = products.length + ' produtos encontrados';
    listingSource.textContent = source || '';

    sendAllToApiBtn.disabled = false;
    sendAllToApiBtn.textContent = 'Salvar todos no Radar Ofertas ML';
    sendAllProgress.classList.add('hidden');

    // Note: "Selecionar Todos" button state is updated by updateSelectionCount() at the end

    // Categoria: seleção/criação 100% manual (sem auto-preencher)
    var categoryInput = document.getElementById('categoryNameInput');
    var categorySelect = document.getElementById('categorySelect');
    var categoryHint = document.getElementById('categoryHint');
    var breadcrumbDisplay = document.getElementById('categoryBreadcrumbDisplay');

    // Helper: set category value in the select/input combo
    function setCategoryValue(name) {
      if (!name) {
        if (categorySelect) categorySelect.value = '';
        if (categoryInput) { categoryInput.value = ''; categoryInput.classList.add('hidden'); }
        return;
      }
      // Check if this name exists in the select options
      if (categorySelect) {
        var found = false;
        for (var i = 0; i < categorySelect.options.length; i++) {
          if (categorySelect.options[i].value === name) {
            categorySelect.value = name;
            if (categoryInput) { categoryInput.value = name; categoryInput.classList.add('hidden'); }
            found = true;
            break;
          }
        }
        if (!found) {
          // New category — show text input
          categorySelect.value = '__new__';
          if (categoryInput) { categoryInput.value = name; categoryInput.classList.remove('hidden'); }
        }
      } else if (categoryInput) {
        categoryInput.value = name;
      }
    }

    if (categoryInput) {
      // Categoria é 100% escolha do usuário: nunca auto-preenchemos nem sugerimos
      // nome detectado da página (para Shopee, Mercado Livre e Amazon). O usuário
      // deve sempre selecionar uma categoria existente ou criar uma nova.
      if (breadcrumbDisplay) breadcrumbDisplay.classList.add('hidden');
      setCategoryValue('');
      if (categoryHint) categoryHint.textContent = 'Selecione uma categoria existente ou crie uma nova';
    }

    // Update collect button in produto tab
    const collectActionEl = document.getElementById('collect-action');
    const collectPageBtnEl = document.getElementById('collect-page-btn');
    if (collectActionEl && products.length > 0) {
      collectActionEl.classList.remove('hidden');
      if (collectPageBtnEl) collectPageBtnEl.textContent = `📦 Coletar ${products.length} Produtos desta Página`;
    }

    listingItems.innerHTML = '';
    products.forEach(function(p, idx) {
      var priceText = p.price ? 'R$ ' + (p.price / 100).toFixed(2).replace('.', ',') : '';
      var origPriceText = (p.originalPrice && p.originalPrice > p.price)
        ? 'R$ ' + (p.originalPrice / 100).toFixed(2).replace('.', ',')
        : '';
      var div = document.createElement('div');
      div.className = 'listing-item';
      div.setAttribute('data-testid', 'listing-item-' + idx);

      var tagNodes = [];
      var itemPlatform = p.platform || currentPlatform;
      // Platform badge — hardcoded text only, no user data
      var badgeNode = document.createElement('span');
      if (itemPlatform === 'shopee') {
        badgeNode.className = 'platform-badge shopee-badge';
        badgeNode.style.cssText = 'background:#EE4D2D;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;';
        badgeNode.textContent = 'Shopee';
      } else if (itemPlatform === 'amazon') {
        badgeNode.className = 'platform-badge amz-badge';
        badgeNode.style.cssText = 'background:#FF9900;color:#111;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;';
        badgeNode.textContent = 'Amazon';
      } else {
        badgeNode.className = 'platform-badge ml-badge';
        badgeNode.style.cssText = 'background:#FFE600;color:#333;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;';
        badgeNode.textContent = 'ML';
      }
      tagNodes.push(badgeNode);
      if (p.categoryName) {
        var catNode = document.createElement('span');
        catNode.className = 'listing-item-tag tag-category';
        catNode.textContent = p.categoryName;
        tagNodes.push(catNode);
      }
      // Selos lidos do card do ML ("Mais vendido", "Ganhos extras 16%"…). textContent,
      // nunca innerHTML: o rótulo vem da página do ML, é dado de terceiro.
      if (Array.isArray(p.tags)) {
        p.tags.forEach(function(tag) {
          var label = String(tag == null ? '' : tag).trim();
          if (!label) return;
          var tagNode = document.createElement('span');
          // Ganho de comissão é o dado que o afiliado procura na tela — destacado.
          var isGanhos = /^ganhos/i.test(label);
          tagNode.className = 'listing-item-tag ' + (isGanhos ? 'tag-ml-ganhos' : 'tag-ml-selo');
          tagNode.textContent = label;
          tagNodes.push(tagNode);
        });
      }
      if (p.offerType) {
        var offerLabels = {
          'oferta_do_dia': 'Oferta do Dia', 'oferta_relampago': 'Oferta Relâmpago',
          'promocao': 'Promoção', 'flash_sale': '⚡ Flash Sale',
          'daily_discover': '🔍 Descobertas do Dia', 'mega_sale': '🔥 Mega Sale',
          'deals': '💰 Deals', 'campaign': '🎯 Campanha', 'collection': '📦 Coleção'
        };
        var offerNode = document.createElement('span');
        offerNode.className = 'listing-item-tag tag-offer';
        offerNode.textContent = offerLabels[p.offerType] || p.offerType;
        tagNodes.push(offerNode);
      }

      var safeImgUrl = safeImageUrl(p.imageUrl);

      // Static structural scaffold — no user data interpolated here
      div.innerHTML =
        '<label class="listing-item-label">' +
          '<input type="checkbox" class="product-checkbox">' +
          (safeImgUrl ? '<img class="listing-item-img" alt="">' : '<div class="listing-item-img-placeholder"></div>') +
          '<div class="listing-item-info">' +
            '<span class="listing-item-title"></span>' +
            '<div class="listing-item-meta">' +
              '<span class="listing-item-price"></span>' +
              (origPriceText ? '<span class="listing-item-orig-price"></span>' : '') +
              (p.discountPercent ? '<span class="listing-item-discount"></span>' : '') +
            '</div>' +
            '<div class="listing-item-details">' +
              (p.sellerName ? '<span class="listing-item-seller"></span>' : '') +
              (p.freeShipping ? '<span class="listing-item-shipping">Frete grátis</span>' : '') +
              ((p.ratingStar || p.rating) ? '<span class="listing-item-rating"></span>' : '') +
              (p.reviewsCount ? '<span class="listing-item-reviews"></span>' : '') +
            '</div>' +
            (tagNodes.length > 0 ? '<div class="listing-item-tags"></div>' : '') +
          '</div>' +
        '</label>' +
        '<span class="listing-item-status pending"></span>';

      // Populate user-controlled values safely via DOM properties
      div.querySelector('.product-checkbox').setAttribute('data-index', idx);
      if (safeImgUrl) div.querySelector('.listing-item-img').src = safeImgUrl;
      div.querySelector('.listing-item-title').textContent = p.productName || '(sem título)';
      div.querySelector('.listing-item-price').textContent = priceText;
      if (origPriceText) div.querySelector('.listing-item-orig-price').textContent = origPriceText;
      if (p.discountPercent) div.querySelector('.listing-item-discount').textContent = '-' + p.discountPercent + '%';
      if (p.sellerName) div.querySelector('.listing-item-seller').textContent = p.sellerName;
      if (p.ratingStar || p.rating) div.querySelector('.listing-item-rating').textContent = formatRatingDisplay(p) + ' ★';
      if (p.reviewsCount) div.querySelector('.listing-item-reviews').textContent = '(' + formatReviewsDisplay(p.reviewsCount) + ')';
      if (tagNodes.length > 0) {
        var tagsContainer = div.querySelector('.listing-item-tags');
        tagNodes.forEach(function(node) { tagsContainer.appendChild(node); });
      }
      div.querySelector('.listing-item-status').id = 'listing-status-' + idx;

      listingItems.appendChild(div);
    });

    // Restore previously checked items after re-render
    if (previouslyChecked.size > 0) {
      products.forEach(function(p, idx) {
        var key = p.asin || p.mlItemId || p.platformItemId || '';
        if (key && previouslyChecked.has(key)) {
          var cb = listingItems.querySelector(`.product-checkbox[data-index="${idx}"]`);
          if (cb) cb.checked = true;
        }
      });
    }

    // Update selection count display
    updateSelectionCount();
  }

  // Função para gerar link de afiliado antes de salvar
  async function enrichWithAffiliateLink(product) {
    if (!product || !product.productLink) return product;

    var platform = detectPlatformFromData(product);
    console.log('[SidePanel] Gerando link de afiliado para:', product.productName?.slice(0, 30), '(platform:', platform + ')');

    var action = platform === 'amazon' ? 'generateAmazonShortLink' : 'generateShortLink';
    const result = await sendMessage({
      action: action,
      url: product.productLink,
      // Amazon: o ASIN do produto viaja junto. Se ele divergir do ASIN da URL, a geração
      // RECUSA em vez de montar um link com a tag certa apontando para outro produto.
      asin: platform === 'amazon' ? (product.asin || product.platformItemId || null) : undefined,
    });

    if (result && result.success && result.short_link) {
      console.log('[SidePanel] Link gerado com sucesso:', result.short_link);
      return {
        ...product,
        affiliateShortLink: result.short_link,
        // Amazon: a tag sobe junto, senão o backend recusa o save (ver isValidAmzAffiliateLink).
        affiliateTag: result.tag || product.affiliateTag || null
      };
    } else {
      console.warn('[SidePanel] Falha ao gerar link:', result?.error || 'sem resposta');
      return product;
    }
  }

  async function saveSelectedProducts(selectedProducts) {
    if (selectedProducts.length === 0) return;

    // Read category from the listing select/input combo
    var manualCategory = readCategoryFromPair('categorySelect', 'categoryNameInput');
    var platform = detectPlatformFromData(selectedProducts[0] || null);

    if (!manualCategory) {
      alert('Selecione uma categoria existente ou digite o nome de uma nova.');
      return;
    }

    // Prepare items for the send queue
    const queueItems = selectedProducts.map(p => {
      const product = { ...p };
      product.categoryName = manualCategory;
      return { product, platform };
    });

    console.log(`[SidePanel] Adding ${queueItems.length} items to send queue (platform: ${platform})`);

    // Send to service worker queue (adds and starts/resumes sending)
    const result = await sendMessage({
      action: 'sendQueue:add',
      items: queueItems,
    });

    if (result && result.success) {
      sendSelectedBtn.disabled = true;
      sendSelectedBtn.textContent = `${queueItems.length} adicionados à fila`;
      hideQueuePausedBanner();
      setTimeout(() => {
        sendSelectedBtn.disabled = false;
        sendSelectedBtn.textContent = 'Enviar Selecionados';
      }, 3000);
    } else {
      console.error('[SidePanel] Erro ao adicionar à fila:', result?.error);
      sendSelectedBtn.textContent = 'Erro — tente novamente';
      setTimeout(() => {
        sendSelectedBtn.textContent = 'Enviar Selecionados';
      }, 3000);
    }
  }

  // Update selection count and button states
  function updateSelectionCount() {
    const total = document.querySelectorAll('.product-checkbox').length;
    const checked = document.querySelectorAll('.product-checkbox:checked').length;

    // Update "Enviar Selecionados" button text with count
    if (checked > 0) {
      sendSelectedBtn.textContent = `Enviar Selecionados (${checked})`;
      sendSelectedBtn.disabled = false;
    } else {
      sendSelectedBtn.textContent = 'Enviar Selecionados';
    }

    // Update "Selecionar Todos" button state
    if (checked === total && total > 0) {
      selectAllBtn.textContent = 'Desmarcar Todos';
      selectAllBtn.classList.add('btn-active');
    } else {
      selectAllBtn.textContent = `Selecionar Todos${checked > 0 ? ` (${checked}/${total})` : ''}`;
      selectAllBtn.classList.remove('btn-active');
    }

    // Update listing count with selection info
    if (checked > 0 && checked < total) {
      listingCount.textContent = `${checked} de ${total} produtos selecionados`;
    } else if (checked === total && total > 0) {
      listingCount.textContent = `Todos ${total} produtos selecionados`;
    } else {
      listingCount.textContent = `${total} produtos encontrados`;
    }
  }

  // Listen for checkbox changes in the listing
  listingItems.addEventListener('change', (e) => {
    if (e.target.classList.contains('product-checkbox')) {
      updateSelectionCount();
    }
  });

  // Evento do botão "Enviar Selecionados"
  sendSelectedBtn.addEventListener('click', async () => {
    if (!currentListingProducts) return;

    const checkboxes = document.querySelectorAll('.product-checkbox:checked');
    if (checkboxes.length === 0) {
      alert('Selecione pelo menos um produto para enviar.');
      return;
    }

    const selectedProducts = Array.from(checkboxes).map(cb => {
      const index = parseInt(cb.dataset.index);
      return {
        ...currentListingProducts[index],
        index: index
      };
    });

    await saveSelectedProducts(selectedProducts);
  });

  // Evento do botão "Selecionar Todos"
  selectAllBtn.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.product-checkbox');
    if (checkboxes.length === 0) return;
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);

    checkboxes.forEach(cb => {
      cb.checked = !allChecked;
    });

    updateSelectionCount();
  });

  // Evento do botão "Enviar Todos" (mantido para compatibilidade)
  sendAllToApiBtn.addEventListener('click', async function() {
    if (!currentListingProducts || currentListingProducts.length === 0) return;

    if (!confirm(`Enviar TODOS os ${currentListingProducts.length} produtos?`)) return;

    const allProducts = currentListingProducts.map((p, i) => ({ ...p, index: i }));
    await saveSelectedProducts(allProducts);
  });

  // ===== SEND QUEUE UI INTEGRATION =====

  // Note: checkbox changes no longer auto-pause the send queue.
  // The queue processes items already added and should not be interrupted
  // by the user browsing/selecting products on other pages.

  function showQueuePausedBanner(reason) {
    const banner = document.getElementById('queue-paused-banner');
    if (!banner) return;
    // O motivo real na frente do texto genérico: "pausado, aguarde 1 min" não
    // ajuda quem precisa refazer o login do Associados Amazon para o envio andar.
    const texto = document.getElementById('queue-paused-text');
    // 'manual'/'paused' são códigos internos, não frase de tela.
    const motivoLegivel = reason && !['manual', 'paused', 'checkbox'].includes(String(reason)) ? reason : null;
    if (texto) {
      texto.textContent = motivoLegivel
        ? '⏸ ' + motivoLegivel + ' (retoma sozinho em 1 min)'
        : '⏸ Envio pausado — clique "Enviar" para continuar ou aguarde 1 min';
    }
    banner.classList.remove('hidden');
  }

  function hideQueuePausedBanner() {
    const banner = document.getElementById('queue-paused-banner');
    if (banner) banner.classList.add('hidden');
  }

  /** Motivo do item mais recente que falhou, para a barra da fila. */
  function ultimoErroDaFila(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i] && items[i].status === 'error' && items[i].errorMessage) {
        return items[i].errorMessage;
      }
    }
    return null;
  }

  function renderQueueError(data) {
    const el = document.getElementById('queue-status-error');
    if (!el) return;
    const motivo = ultimoErroDaFila(data);
    if (motivo && (data.errors || 0) > 0) {
      el.textContent = '⚠ ' + motivo;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  function updateQueueStatusBar(data) {
    const bar = document.getElementById('queue-status-bar');
    if (!bar) return;

    // Lote terminou COM erro: a barra fica, com o resumo e o motivo. Escondê-la
    // aqui apagava a explicação no exato instante em que o usuário ia lê-la —
    // ele via "10 erros" durante o envio e, ao voltar, uma tela limpa.
    if (data.status === 'idle' && (data.pending === 0 || data.pending === undefined) && (data.errors || 0) === 0) {
      bar.classList.add('hidden');
      hideQueuePausedBanner();
      const erroEl = document.getElementById('queue-status-error');
      if (erroEl) { erroEl.textContent = ''; erroEl.classList.add('hidden'); }
      // Refresh category suggestions — new categories may have been created
      invalidateCategoriesCache();
      if (currentPlatform === 'ml') {
        loadMlCategorySuggestions();
      } else if (currentPlatform === 'amazon') {
        loadAmazonCategorySuggestions();
      } else {
        loadCustomCategorySuggestions();
      }
      return;
    }

    bar.classList.remove('hidden');
    const statusText = bar.querySelector('.queue-status-text');
    const progressFill = bar.querySelector('.queue-progress-fill');

    renderQueueError(data);

    if (data.status === 'sending') {
      hideQueuePausedBanner();
      const sent = data.sent || 0;
      const errors = data.errors || 0;
      const pending = data.pending || 0;
      const total = sent + errors + pending;
      const errPart = errors > 0 ? `, ${errors} erro${errors > 1 ? 's' : ''}` : '';
      statusText.textContent = `Enviando... ${sent}/${total} (${pending} restantes${errPart})`;
    } else if (data.status === 'paused') {
      statusText.textContent = `Pausado — ${data.pending || 0} pendentes (retoma em 1 min)`;
      showQueuePausedBanner(data.pauseReason);
    } else {
      // Show detailed summary with duplicates and filtered info
      const parts = [`${data.sent || 0} enviados`];
      const dupes = data.duplicates || 0;
      const filtered = data.filtered || 0;
      if (dupes > 0) parts.push(`${dupes} duplicados`);
      if (filtered > 0) parts.push(`${filtered} filtrados`);
      if ((data.errors || 0) - filtered > 0) parts.push(`${(data.errors || 0) - filtered} erros`);
      statusText.textContent = `Fila: ${parts.join(', ')}`;
    }

    const sent = data.sent || 0;
    const total = sent + (data.errors || 0) + (data.pending || 0);
    const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
    if (progressFill) progressFill.style.width = `${pct}%`;
  }

  // Listen for queue status updates from service worker (additional listener)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'sendQueue:status') {
      updateQueueStatusBar(message);
    }
  });

  // Queue clear button
  const queueClearBtn = document.getElementById('queue-clear-btn');
  if (queueClearBtn) {
    queueClearBtn.addEventListener('click', async () => {
      if (confirm('Limpar fila de envio? Produtos pendentes não serão enviados.')) {
        await sendMessage({ action: 'sendQueue:clear' });
        hideQueuePausedBanner();
      }
    });
  }

  // Load queue state when sidebar opens
  async function loadQueueState() {
    const result = await sendMessage({ action: 'sendQueue:getState' });
    if (result && result.success && result.data) {
      updateQueueStatusBar(result.data);
      if (result.data.status === 'paused' && result.data.pending > 0) {
        showQueuePausedBanner(result.data.pauseReason);
      }
    }
  }

  // ===== END SEND QUEUE UI =====

  generateLinkBtn.addEventListener('click', async () => {
    if (!currentProduct) return;

    // Shopee: save directly without generating affiliate link
    if (currentPlatform === 'shopee') {
      // Ler categoria do select/input combo (produto único)
      var userCatShopeeGen = readCategoryFromPair('singleProductCategorySelect', 'singleProductCategoryInput');
      if (!userCatShopeeGen) {
        alert('Selecione uma categoria existente ou digite o nome de uma nova.');
        return;
      }

      generateLinkBtn.disabled = true;
      generateLinkBtn.textContent = 'Salvando...';

      var shopeeProductGen = { ...currentProduct, categoryName: userCatShopeeGen };
      console.log('[SidePanel] Shopee save - categoryName:', userCatShopeeGen, '| product keys:', Object.keys(shopeeProductGen).filter(k => k.toLowerCase().includes('cat')));
      const saveResult = await sendMessage({
        action: 'saveShopeeProducts',
        products: [shopeeProductGen],
      });

      generateLinkBtn.disabled = false;
      generateLinkBtn.textContent = 'Salvar Produto';

      if (saveResult && saveResult.success) {
        generateLinkBtn.textContent = '✓ Salvo!';
        setTimeout(() => { generateLinkBtn.textContent = 'Salvar Produto'; }, 2500);
      } else {
        alert(saveResult?.error || 'Erro ao salvar produto Shopee');
      }
      return;
    }

    // Amazon: generate affiliate link + save in one action
    if (currentPlatform === 'amazon') {
      var userCatAmzGen = readCategoryFromPair('singleProductCategorySelect', 'singleProductCategoryInput');
      if (!userCatAmzGen) {
        alert('Selecione uma categoria existente ou digite o nome de uma nova.');
        return;
      }

      if (!currentProduct?.productLink) return;

      generateLinkBtn.disabled = true;
      generateLinkBtn.textContent = 'Gerando link...';

      const enriched = await enrichWithAffiliateLink(currentProduct);
      enriched.categoryName = userCatAmzGen;

      if (!enriched.affiliateShortLink) {
        generateLinkBtn.disabled = false;
        generateLinkBtn.textContent = 'Salvar Produto';
        alert('Não foi possível gerar o link de afiliado. Verifique se está logado no Amazon Associates.');
        return;
      }

      affiliateLinkInput.value = enriched.affiliateShortLink;
      affiliateLinkResult.classList.remove('hidden');

      generateLinkBtn.textContent = 'Salvando...';
      const saveResult = await sendMessage({
        action: 'saveAmazonProducts',
        products: [enriched],
      });

      generateLinkBtn.disabled = false;
      if (saveResult && saveResult.success) {
        generateLinkBtn.textContent = '✓ Salvo!';
        invalidateCategoriesCache();
        setTimeout(() => { generateLinkBtn.textContent = 'Salvar Produto'; }, 2500);
      } else {
        generateLinkBtn.textContent = 'Salvar Produto';
        alert(saveResult?.error || 'Link gerado mas erro ao salvar');
      }
      return;
    }

    // ML: generate affiliate link + save in one action
    if (currentPlatform === 'ml') {
      var userCatMlGen = readCategoryFromPair('singleProductCategorySelect', 'singleProductCategoryInput');
      if (!userCatMlGen) {
        alert('Selecione uma categoria existente ou digite o nome de uma nova.');
        return;
      }

      if (!currentProduct?.productLink) return;

      generateLinkBtn.disabled = true;
      generateLinkBtn.textContent = 'Gerando link...';

      const enriched = await enrichWithAffiliateLink(currentProduct);
      enriched.categoryName = userCatMlGen;

      if (!enriched.affiliateShortLink) {
        generateLinkBtn.disabled = false;
        generateLinkBtn.textContent = 'Salvar Produto';
        alert('Não foi possível gerar o link de afiliado. Verifique se está logado no ML Afiliados.');
        return;
      }

      affiliateLinkInput.value = enriched.affiliateShortLink;
      affiliateLinkResult.classList.remove('hidden');

      generateLinkBtn.textContent = 'Salvando...';
      const saveResult = await sendMessage({ action: 'saveProduct', productData: enriched });

      generateLinkBtn.disabled = false;
      if (saveResult && saveResult.success) {
        generateLinkBtn.textContent = '✓ Salvo!';
        invalidateCategoriesCache();
        setTimeout(() => { generateLinkBtn.textContent = 'Salvar Produto'; }, 2500);
      } else {
        generateLinkBtn.textContent = 'Salvar Produto';
        alert(saveResult?.error || 'Link gerado mas erro ao salvar produto');
      }
      return;
    }

    // Other platforms: just generate affiliate link
    if (!currentProduct?.productLink) return;

    generateLinkBtn.disabled = true;
    generateLinkBtn.textContent = 'Gerando...';

    const result = await sendMessage({
      action: 'generateShortLink',
      url: currentProduct.productLink,
    });

    generateLinkBtn.disabled = false;
    generateLinkBtn.textContent = 'Gerar Link de Afiliado';

    if (result && result.success && result.short_link) {
      affiliateLinkInput.value = result.short_link;
      affiliateLinkResult.classList.remove('hidden');
      currentProduct.affiliateShortLink = result.short_link;
    } else {
      alert(result?.error || 'Erro ao gerar link. Verifique se está logado no ML Afiliados.');
    }
  });

  copyLinkBtn.addEventListener('click', () => {
    affiliateLinkInput.select();
    navigator.clipboard.writeText(affiliateLinkInput.value);
    copyLinkBtn.textContent = 'Copiado!';
    setTimeout(() => { copyLinkBtn.textContent = 'Copiar'; }, 1500);
  });

  sendToApiBtn.addEventListener('click', async () => {
    if (!currentProduct) return;

    sendToApiBtn.disabled = true;
    sendToApiBtn.textContent = 'Enviando...';

    // Shopee: save without affiliate link
    if (currentPlatform === 'shopee') {
      // Ler categoria editada pelo usuário antes de enviar
      var catInputShopee = document.getElementById('categoryNameInput');
      var userCategoryShopee = catInputShopee ? catInputShopee.value.trim() : '';
      if (!userCategoryShopee) {
        sendToApiBtn.disabled = false;
        sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';
        alert('Informe o nome da categoria antes de salvar.');
        return;
      }
      var shopeeProduct = { ...currentProduct, categoryName: userCategoryShopee };

      const saveResult = await sendMessage({
        action: 'saveShopeeProducts',
        products: [shopeeProduct],
      });

      sendToApiBtn.disabled = false;
      sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';

      if (saveResult && saveResult.success) {
        sendToApiBtn.textContent = '✓ Salvo!';
        setTimeout(() => { sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML'; }, 2500);
      } else {
        alert(saveResult?.error || 'Erro ao salvar produto Shopee');
      }
      return;
    }

    // Amazon: generate affiliate link then save via Amazon endpoint
    if (currentPlatform === 'amazon') {
      // Ler categoria editada pelo usuário antes de enviar
      var catInput = document.getElementById('categoryNameInput');
      var userCategory = catInput ? catInput.value.trim() : '';
      if (!userCategory) {
        sendToApiBtn.disabled = false;
        sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';
        alert('Informe o nome da categoria antes de salvar.');
        return;
      }

      const enriched = await enrichWithAffiliateLink(currentProduct);
      enriched.categoryName = userCategory;

      if (!enriched.affiliateShortLink) {
        sendToApiBtn.disabled = false;
        sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';
        alert('Não foi possível gerar o link de afiliado. Verifique se está logado no Amazon Associates.');
        return;
      }

      const result = await sendMessage({
        action: 'saveAmazonProducts',
        products: [enriched],
      });

      sendToApiBtn.disabled = false;
      sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';

      if (result && result.success) {
        sendToApiBtn.textContent = '✓ Salvo com link!';
        setTimeout(() => { sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML'; }, 2500);
      } else {
        alert(result?.error || 'Erro ao salvar produto Amazon');
      }
      return;
    }

    // Ler categoria editada pelo usuário antes de enviar
    var catInputML = document.getElementById('categoryNameInput');
    var userCategoryML = catInputML ? catInputML.value.trim() : '';
    if (!userCategoryML) {
      sendToApiBtn.disabled = false;
      sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';
      alert('Informe o nome da categoria antes de salvar.');
      return;
    }

    const enriched = await enrichWithAffiliateLink(currentProduct);
    enriched.categoryName = userCategoryML;

    if (!enriched.affiliateShortLink) {
      sendToApiBtn.disabled = false;
      sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';
      alert('Não foi possível gerar o link de afiliado. Verifique se está logado no ML Afiliados.');
      return;
    }

    const result = await sendMessage({ action: 'saveProduct', productData: enriched });

    sendToApiBtn.disabled = false;
    sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML';

    if (result && result.success) {
      sendToApiBtn.textContent = '✓ Salvo com link!';
      setTimeout(() => { sendToApiBtn.textContent = 'Salvar no Radar Ofertas ML'; }, 2500);
    } else {
      alert(result?.error || 'Erro ao enviar produto');
    }
  });

  function formatPromoMessage(prod) {
    const templateType = document.getElementById('templateSelect')?.value || 'achadinhos';
    const price = formatPrice(prod.price);
    const originalPrice = prod.originalPrice ? formatPrice(prod.originalPrice) : '';
    const discount = prod.discountPercent ? `${prod.discountPercent}%` : '';
    const shipping = prod.freeShipping ? 'Frete Grátis 🚚' : 'Envio para todo o Brasil 📦';
    const link = prod.affiliateShortLink || prod.productLink || '';
    const title = prod.productName || 'Produto em Promoção';

    if (templateType === 'flash') {
      return [
        `⚡ *ALERTA RELÂMPAGO!*`,
        ``,
        `*${title}*`,
        `Por apenas *${price}* 🔥`,
        originalPrice ? `(De ~${originalPrice}~)` : '',
        `🚚 ${shipping}`,
        ``,
        `👉 *Corra antes que esgote:*`,
        `${link}`,
      ].filter(Boolean).join('\n');
    }

    if (templateType === 'default') {
      return [
        `🏷️ *PROMOÇÃO MERCADO LIVRE*`,
        ``,
        `📦 *${title}*`,
        ``,
        originalPrice ? `💰 *${price}* (era ~${originalPrice}~)` : `💰 *${price}*`,
        discount ? `💥 *${discount} de desconto!*` : '',
        `🚚 ${shipping}`,
        ``,
        `👉 *Acesse pelo link oficial:*`,
        `${link}`,
      ].filter(Boolean).join('\n');
    }

    // Default: achadinhos
    return [
      `🔥 *ACHADINHO DO DIA!*`,
      ``,
      `*${title}*`,
      ``,
      originalPrice ? `De ~${originalPrice}~` : '',
      discount ? `Por apenas *${price}* 💵 (${discount} OFF)` : `Por apenas *${price}* 💵`,
      `🚚 ${shipping}`,
      ``,
      `🛒 *Compre direto no link oficial:*`,
      `${link}`,
    ].filter(Boolean).join('\n');
  }

  copyWhatsappBtn.addEventListener('click', () => {
    if (!currentProduct) return;
    const text = formatPromoMessage(currentProduct);
    navigator.clipboard.writeText(text);
    copyWhatsappBtn.textContent = '✓ Mensagem Copiada!';
    setTimeout(() => { copyWhatsappBtn.textContent = '📋 Copiar Mensagem WhatsApp'; }, 1800);
  });

  const directWhatsappBtn = document.getElementById('direct-whatsapp-btn');
  if (directWhatsappBtn) {
    directWhatsappBtn.addEventListener('click', () => {
      if (!currentProduct) return;
      const text = formatPromoMessage(currentProduct);
      const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank');
    });
  }

  // loadKeywords() and startKeywordSearchBtn removed — keywords now used only via schedule UI

  // Automation control UI removed — only schedule UI remains


  saveApiUrlBtn.addEventListener('click', async () => {
    const url = apiUrlInput.value.trim();
    if (url) {
      await sendMessage({ action: 'setApiBaseUrl', url });
      saveApiUrlBtn.textContent = 'Salvo!';
      setTimeout(() => { saveApiUrlBtn.textContent = 'Salvar'; }, 1500);
    }
  });

  async function switchEnvironment(env) {
    const envResult = await sendMessage({ action: 'getApiEnvironment' });
    if (envResult?.env === env) return;

    await sendMessage({ action: 'setApiEnvironment', env });
    updateEnvBadge(env);
    updateEnvSelector(env);

    const urlResult = await sendMessage({ action: 'getApiBaseUrl' });
    if (urlResult?.url) {
      apiUrlInput.value = urlResult.url;
    }

    await sendMessage({ action: 'logout' });
    showLogin();

    const envLabel = env === 'dev' ? 'Desenvolvimento' : 'Produção';
    loginError.textContent = `Ambiente alterado para ${envLabel}. Faça login novamente.`;
    loginError.style.color = 'var(--warning)';
  }

  envBtnProd.addEventListener('click', () => switchEnvironment('prod'));
  envBtnDev.addEventListener('click', () => switchEnvironment('dev'));

  saveFiltersBtn.addEventListener('click', async () => {
    const config = {
      freeShippingOnly: filterFreeShipping.checked,
      minRating: parseInt(filterMinRating.value) || 0,
      minDiscount: parseInt(filterMinDiscount.value) || 0,
      maxPrice: filterMaxPrice.value ? parseInt(filterMaxPrice.value) * 100 : null,
    };

    saveFiltersBtn.disabled = true;
    const result = await sendMessage({ action: 'updateConfig', config });
    saveFiltersBtn.disabled = false;

    if (result?.success) {
      saveFiltersBtn.textContent = 'Salvo!';
      setTimeout(() => { saveFiltersBtn.textContent = 'Salvar Filtros'; }, 1500);
    } else {
      alert(result?.error || 'Erro ao salvar filtros');
    }
  });

  async function loadConfig() {
    const envResult = await sendMessage({ action: 'getApiEnvironment' });
    const currentEnv = envResult?.env || 'prod';
    updateEnvBadge(currentEnv);
    updateEnvSelector(currentEnv);

    const urlResult = await sendMessage({ action: 'getApiBaseUrl' });
    if (urlResult?.url) {
      apiUrlInput.value = urlResult.url;
    }

    const configResult = await sendMessage({ action: 'getConfig' });
    if (configResult?.success && configResult.data) {
      const c = configResult.data;
      filterFreeShipping.checked = c.freeShippingOnly || false;
      filterMinRating.value = c.minRating || '';
      filterMinDiscount.value = c.minDiscount || '';
      filterMaxPrice.value = c.maxPrice ? c.maxPrice / 100 : '';
    }
  }

  // Track the current page URL to avoid stale data from previous pages
  let currentPageUrl = null;

  /**
   * O guard de URL stale abaixo compara a URL do lote com a que o painel tem. No hub de
   * afiliados do ML isso precisa ignorar o FRAGMENTO: a página carrega com `#menu-user`
   * e reescreve a âncora durante o uso, e o content script (que deliberadamente NÃO
   * anuncia `pageChanged` nessas trocas, para não apagar a lista acumulada no meio da
   * rolagem) passaria a emitir com um hash que o painel ainda não conhece — todo lote do
   * scroll seria descartado como "stale".
   * Fora do hub a comparação continua literal: na PDP o fragmento (`wid=MLB…`)
   * identifica O ITEM, e ignorá-lo deixaria o painel exibir o produto errado.
   */
  function mesmaPaginaParaExtracao(urlA, urlB) {
    if (urlA === urlB) return true;
    var ehHub = function (u) { return /\/afiliados\/hub(?:[/?#]|$)/i.test(String(u || '')); };
    if (!ehHub(urlA) || !ehHub(urlB)) return false;
    var semHash = function (u) { return String(u).split('#')[0]; };
    return semHash(urlA) === semHash(urlB);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'offerExtracted' && message.data) {
      // Vale para lista E produto único: uma extração da URL A pode terminar
      // depois que a navegação SPA já anunciou a URL B. Sem este guard no ramo
      // de produto, o painel reabria o card antigo e ainda permitia salvá-lo.
      if (currentPageUrl && message.url && !mesmaPaginaParaExtracao(message.url, currentPageUrl)) {
        console.log('[SidePanel] Skipping offerExtracted (stale URL):', message.url, '!=', currentPageUrl);
        return;
      }
      if (message.url) currentPageUrl = message.url;
      if (message.platform) currentPlatform = message.platform;

      if (Array.isArray(message.data)) {
        // replaceMode=true vem do scraper Amazon após SPA-nav (filtro de
        // categoria/preço/desconto) — DOM pode ter passado de N produtos
        // antigos para M < N produtos do filtro real, e o filtro normal de
        // length rejeitaria esse update legítimo. Em replaceMode aceita
        // independente de count e SUBSTITUI a lista (não acumula).
        if (message.replaceMode) {
          console.log('[SidePanel] offerExtracted (replaceMode):', message.data.length, 'produtos');
          currentListingProducts = null; // garante substituição limpa em displayListing
          displayListing(message.data, message.source);
          displaySaveListProducts(message.data);
          return;
        }

        // Only skip fewer products (scroll accumulation protection)
        if (currentListingProducts && currentListingProducts.length > message.data.length) {
          console.log(`[SidePanel] Skipping offerExtracted: current ${currentListingProducts.length} > incoming ${message.data.length}`);
          return;
        }
        displayListing(message.data, message.source);
        displaySaveListProducts(message.data);
      } else {
        displayProduct(message.data);
      }
    }

    if (message.action === 'batchSaveProgress') {
      var pct = Math.round((message.current / message.total) * 100);
      sendAllProgressFill.style.width = pct + '%';
      sendAllProgressText.textContent = message.current + '/' + message.total + ' (' + message.saved + ' salvos)';
    }

    if (message.action === 'pageChanged') {
      // URL changed within the page — reset products so stale data from previous page is cleared
      console.log('[SidePanel] Page changed to:', message.url);
      currentListingProducts = null;
      currentProduct = null;
      if (message.url) currentPageUrl = message.url;
      // Limpa também as ações e a aba Lista enquanto a nova página hidrata:
      // manter os objetos antigos aqui deixava o usuário salvar o produto da URL
      // anterior antes do próximo offerExtracted.
      noProduct.classList.remove('hidden');
      productCard.classList.add('hidden');
      listingCard.classList.add('hidden');
      var saveListNoProductsEl = document.getElementById('save-list-no-products');
      var saveListContentEl = document.getElementById('save-list-content');
      var saveListItemsEl = document.getElementById('save-list-items');
      if (saveListNoProductsEl) saveListNoProductsEl.classList.remove('hidden');
      if (saveListContentEl) saveListContentEl.classList.add('hidden');
      if (saveListItemsEl) saveListItemsEl.textContent = '';
      // Não dispara requestExtraction aqui: o content script já roda
      // performExtractionWithRetry após pageChanged. Disparar extractOffer
      // síncrono em +1s pegava o React no meio da hidratação (lista vazia)
      // e ainda travava o filtro `length > message.data.length` do
      // offerExtracted, fazendo a sidepanel ignorar o resultado completo
      // do retry posterior.
    }

    if (message.action === 'tabUpdated' && message.tab?.isSupported) {
      if (message.tab.url) currentPageUrl = message.tab.url;
      setTimeout(requestExtraction, 500);
    }
  });

  // ===== SCHEDULE FUNCTIONALITY =====

  const scheduleEnabled = document.getElementById('schedule-enabled');
  const scheduleConfig = document.getElementById('schedule-config');
  const scheduleSaveBtn = document.getElementById('schedule-save-btn');
  const scheduleStatus = document.getElementById('schedule-status');
  const scheduleLastExec = document.getElementById('schedule-last-exec');
  const scheduleNextExec = document.getElementById('schedule-next-exec');
  const scheduleKeywordGroups = document.getElementById('schedule-keyword-groups');

  const PERIOD_LABELS = {
    madrugada: 'Madrugada (00-06h)',
    manha: 'Manhã (06-12h)',
    tarde: 'Tarde (12-18h)',
    noite: 'Noite (18-00h)',
  };

  scheduleEnabled.addEventListener('change', () => {
    scheduleConfig.classList.toggle('hidden', !scheduleEnabled.checked);
  });

  // Toggle agendamento section
  document.getElementById('toggle-agendamento').addEventListener('click', () => {
    const body = document.getElementById('agendamento-body');
    const arrow = document.getElementById('agendamento-arrow');
    body.classList.toggle('collapsed');
    arrow.classList.toggle('collapsed');
  });

  async function loadScheduleUI() {
    const result = await sendMessage({ action: 'getSchedule' });
    const cfg = result?.data || {};

    scheduleEnabled.checked = !!cfg.enabled;
    scheduleConfig.classList.toggle('hidden', !cfg.enabled);

    // Set period checkboxes
    document.querySelectorAll('.schedule-period-cb').forEach(cb => {
      cb.checked = cfg.periods && cfg.periods.includes(cb.value);
    });

    // Set platform checkboxes and toggle panels
    document.querySelectorAll('.schedule-platform-cb').forEach(cb => {
      cb.checked = cfg.platforms ? cfg.platforms.includes(cb.value) : false;
      const panel = cb.closest('.source-item')?.querySelector('.source-panel');
      if (panel) panel.classList.toggle('hidden', !cb.checked);

      // Toggle panel on change
      cb.addEventListener('change', () => {
        if (panel) panel.classList.toggle('hidden', !cb.checked);
      });
    });

    // Set sub-source checkboxes
    const sourceSubs = cfg.sourceSubs || {};
    document.querySelectorAll('.source-sub-cb').forEach(cb => {
      const source = cb.dataset.source;
      const sub = cb.dataset.sub;
      cb.checked = sourceSubs[source]?.includes(sub) || false;

      // Toggle offer types visibility when "Tipos de Oferta" is checked/unchecked
      if (sub === 'offer_types') {
        const offerPanel = cb.closest('.source-panel')?.querySelector(`.source-offer-types[data-source="${source}"]`);
        if (offerPanel) {
          offerPanel.classList.toggle('hidden', !cb.checked);
          cb.addEventListener('change', () => {
            offerPanel.classList.toggle('hidden', !cb.checked);
          });
        }
      }
    });

    // Set offer type checkboxes
    const offerTypes = cfg.offerTypes || {};
    document.querySelectorAll('.source-offer-cb').forEach(cb => {
      const source = cb.dataset.source;
      cb.checked = offerTypes[source]?.includes(cb.value) || false;
    });

    // Load lists for Listas source
    try {
      const listsResult = await fetchListsCached();
      const lists = listsResult?.data || listsResult?.lists || [];
      const listsContainer = document.getElementById('schedule-lists-container');
      if (listsContainer) {
        listsContainer.innerHTML = '';
        if (lists.length === 0) {
          listsContainer.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">Nenhuma lista criada</div>';
        } else {
          const selectedListIds = cfg.selectedListIds || [];
          lists.forEach(list => {
            const label = document.createElement('label');
            label.className = 'source-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'schedule-list-cb';
            checkbox.value = list.id;
            checkbox.checked = selectedListIds.includes(String(list.id)) || selectedListIds.includes(list.id);
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(' ' + list.name));
            listsContainer.appendChild(label);
          });
        }
      }
    } catch (e) {
      const listsContainer = document.getElementById('schedule-lists-container');
      if (listsContainer) listsContainer.innerHTML = '<div style="font-size: 11px; color: var(--danger);">Erro ao carregar listas</div>';
    }

    // Load keyword groups
    try {
      const kwResult = await sendMessage({ action: 'getKeywordSearches' });
      const keywords = kwResult?.data?.keywords || kwResult?.keywords || [];
      scheduleKeywordGroups.innerHTML = '';

      if (keywords.length === 0) {
        scheduleKeywordGroups.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">Nenhum grupo configurado</div>';
      } else {
        keywords.forEach(kw => {
          const kwCount = Array.isArray(kw.keywords) ? kw.keywords.length : 0;
          const checked = cfg.keywordGroupIds && cfg.keywordGroupIds.includes(String(kw.id));
          const div = document.createElement('label');
          div.className = 'schedule-kw-item';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'schedule-kw-cb';
          checkbox.value = kw.id;
          if (checked) checkbox.checked = true;

          const span = document.createElement('span');
          span.appendChild(document.createTextNode(kw.name + ' '));

          const countSpan = document.createElement('span');
          countSpan.style.color = 'var(--text-muted)';
          countSpan.style.fontSize = '10px';
          countSpan.textContent = `(${kwCount} palavras)`;
          span.appendChild(countSpan);

          div.appendChild(checkbox);
          div.appendChild(span);
          scheduleKeywordGroups.appendChild(div);
        });
      }
    } catch (e) {
      scheduleKeywordGroups.innerHTML = '<div style="font-size: 11px; color: var(--danger);">Erro ao carregar grupos</div>';
    }

    // Show status
    if (cfg.lastExecutionDate || cfg.enabled) {
      scheduleStatus.classList.remove('hidden');

      if (cfg.lastExecutionDate) {
        const parts = cfg.lastExecutionDate.split('-');
        const dateStr = `${parts[2]}/${parts[1]}`;
        const r = cfg.lastExecutionResult;
        scheduleLastExec.textContent = `Última: ${dateStr} às ${cfg.lastExecutionTime || '??:??'} — ${r ? r.totalSaved + ' salvos' : 'sem dados'}`;
      } else {
        scheduleLastExec.textContent = 'Última: nunca executou';
      }

      if (cfg.enabled && cfg.periods && cfg.periods.length > 0) {
        const periodNames = cfg.periods.map(p => PERIOD_LABELS[p] || p).join(', ');
        scheduleNextExec.textContent = `Próxima: ${periodNames}`;
      } else {
        scheduleNextExec.textContent = '';
      }
    } else {
      scheduleStatus.classList.add('hidden');
    }
  }

  scheduleSaveBtn.addEventListener('click', async () => {
    const periods = Array.from(document.querySelectorAll('.schedule-period-cb:checked')).map(cb => cb.value);
    const keywordGroupIds = Array.from(document.querySelectorAll('.schedule-kw-cb:checked')).map(cb => cb.value);
    const platforms = Array.from(document.querySelectorAll('.schedule-platform-cb:checked')).map(cb => cb.value);
    const enabled = scheduleEnabled.checked;

    if (enabled && periods.length === 0) {
      alert('Selecione pelo menos um período.');
      return;
    }
    if (enabled && platforms.length === 0) {
      alert('Selecione pelo menos uma fonte de produtos.');
      return;
    }
    if (enabled && keywordGroupIds.length === 0) {
      alert('Selecione pelo menos um grupo de palavras-chave.');
      return;
    }

    scheduleSaveBtn.disabled = true;
    scheduleSaveBtn.textContent = 'Salvando...';

    // Preserve last execution data
    const current = await sendMessage({ action: 'getSchedule' });
    const currentCfg = current?.data || {};

    // Collect sub-sources per platform
    const sourceSubs = {};
    document.querySelectorAll('.source-sub-cb:checked').forEach(cb => {
      const source = cb.dataset.source;
      if (!sourceSubs[source]) sourceSubs[source] = [];
      sourceSubs[source].push(cb.dataset.sub);
    });

    // Collect offer types per platform
    const offerTypes = {};
    document.querySelectorAll('.source-offer-cb:checked').forEach(cb => {
      const source = cb.dataset.source;
      if (!offerTypes[source]) offerTypes[source] = [];
      offerTypes[source].push(cb.value);
    });

    // Collect selected lists
    const selectedListIds = Array.from(document.querySelectorAll('.schedule-list-cb:checked')).map(cb => cb.value);

    const newConfig = {
      enabled,
      periods,
      keywordGroupIds,
      platforms,
      sourceSubs,
      offerTypes,
      selectedListIds,
      lastExecutionDate: currentCfg.lastExecutionDate || null,
      lastExecutionTime: currentCfg.lastExecutionTime || null,
      lastExecutionResult: currentCfg.lastExecutionResult || null,
    };

    const result = await sendMessage({ action: 'saveSchedule', config: newConfig });

    scheduleSaveBtn.disabled = false;
    scheduleSaveBtn.textContent = 'Salvar Agendamento';

    if (result?.success) {
      showToast(enabled ? 'Agendamento ativado' : 'Agendamento desativado');
      loadScheduleUI();
    } else {
      showToast(result?.error || 'Erro ao salvar', 'error');
    }
  });

  // Load schedule UI when automation tab is clicked
  document.querySelector('[data-tab="automacao"]').addEventListener('click', () => {
    loadScheduleUI();
  });

  // ===== LISTAS FUNCTIONALITY =====

  const saveListNoProducts = document.getElementById('save-list-no-products');
  const saveListContent = document.getElementById('save-list-content');
  const saveListSelect = document.getElementById('save-list-select');
  const saveListNewBtn = document.getElementById('save-list-new-btn');
  const saveListNewInputRow = document.getElementById('save-list-new-input-row');
  const saveListNewName = document.getElementById('save-list-new-name');
  const saveListCreateBtn = document.getElementById('save-list-create-btn');
  const saveListCancelBtn = document.getElementById('save-list-cancel-btn');
  const saveListCount = document.getElementById('save-list-count');
  const saveListSelectAllBtn = document.getElementById('save-list-select-all-btn');
  const saveListSaveBtn = document.getElementById('save-list-save-btn');
  const saveListItemsContainer = document.getElementById('save-list-items');

  const listasLoading = document.getElementById('listas-loading');
  const listasEmpty = document.getElementById('listas-empty');
  const listasContainer = document.getElementById('listas-container');
  const listasList = document.getElementById('listas-list');

  let saveListProducts = [];

  function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // Cache para getLists — evita chamadas duplicadas em sequência
  let _listsCache = null;
  let _listsCacheTime = 0;
  const LISTS_CACHE_TTL = 3000; // 3 segundos

  async function fetchListsCached(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _listsCache && (now - _listsCacheTime) < LISTS_CACHE_TTL) {
      return _listsCache;
    }
    const result = await sendMessage({ action: 'getLists' });
    if (result?.success) {
      _listsCache = result;
      _listsCacheTime = Date.now();
    }
    return result;
  }

  function invalidateListsCache() {
    _listsCache = null;
    _listsCacheTime = 0;
  }

  // Load lists into the select dropdown
  async function loadListsDropdown() {
    const result = await fetchListsCached();
    if (!result?.success) return;

    const lists = result.data || [];
    saveListSelect.innerHTML = '<option value="">Selecione uma lista...</option>';
    lists.forEach(list => {
      const opt = document.createElement('option');
      opt.value = list.id;
      opt.textContent = `${list.name} (${list.activeItemCount || 0} ativos)`;
      saveListSelect.appendChild(opt);
    });
  }

  // Display products in the "Salvar" tab
  function displaySaveListProducts(products) {
    saveListProducts = products || [];
    if (saveListProducts.length === 0) {
      saveListNoProducts.classList.remove('hidden');
      saveListContent.classList.add('hidden');
      return;
    }

    saveListNoProducts.classList.add('hidden');
    saveListContent.classList.remove('hidden');
    saveListCount.textContent = `${saveListProducts.length} produtos`;

    // Reset "Selecionar Todos" button state when new products load
    saveListSelectAllBtn.textContent = 'Selecionar Todos';
    saveListSelectAllBtn.classList.remove('btn-active');

    // Categoria da aba Listas: seleção/criação manual (sem auto-detectar)
    var saveListCategoryGroup = document.getElementById('save-list-category-group');
    var saveListCategorySelect = document.getElementById('saveListCategorySelect');
    var saveListCategoryInput = document.getElementById('saveListCategoryInput');
    var saveListBreadcrumb = document.getElementById('saveListCategoryBreadcrumb');
    var saveListCategoryHint = document.getElementById('saveListCategoryHint');

    if (saveListCategoryGroup) {
      saveListCategoryGroup.style.display = 'block';

      // Carrega categorias da plataforma no select (a partir do primeiro produto)
      var saveListPlatform = detectPlatformFromData(saveListProducts[0] || null);
      loadSaveListCategories(saveListPlatform);

      // Limpa qualquer valor anterior: usuário sempre escolhe/cria
      if (saveListCategorySelect) saveListCategorySelect.value = '';
      if (saveListCategoryInput) {
        saveListCategoryInput.value = '';
        saveListCategoryInput.classList.add('hidden');
        saveListCategoryInput.placeholder = 'Digite o nome da nova categoria...';
      }
      if (saveListBreadcrumb) saveListBreadcrumb.classList.add('hidden');
      if (saveListCategoryHint) {
        saveListCategoryHint.textContent = 'Selecione uma categoria existente ou crie uma nova (opcional — se vazio, usa o nome da lista)';
      }
    }

    saveListItemsContainer.innerHTML = '';

    saveListProducts.forEach((p, idx) => {
      const div = document.createElement('div');
      div.className = 'listing-item';
      const priceFormatted = p.price ? `R$ ${(p.price / 100).toFixed(2).replace('.', ',')}` : '';
      const origPriceFormatted = p.originalPrice ? `R$ ${(p.originalPrice / 100).toFixed(2).replace('.', ',')}` : '';
      // Build structural skeleton via safe DOM methods (no innerHTML)
      const label = document.createElement('label');
      label.className = 'listing-item-label';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'save-list-checkbox';
      checkbox.dataset.index = idx;
      label.appendChild(checkbox);
      const imgSlotEl = document.createElement('div');
      imgSlotEl.className = 'listing-item-img-slot';
      label.appendChild(imgSlotEl);
      const infoDiv = document.createElement('div');
      infoDiv.className = 'listing-item-info';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'listing-item-title';
      infoDiv.appendChild(titleDiv);
      const metaDiv = document.createElement('div');
      metaDiv.className = 'listing-item-meta';
      const priceSpan = document.createElement('span');
      priceSpan.className = 'listing-item-price';
      metaDiv.appendChild(priceSpan);
      infoDiv.appendChild(metaDiv);
      const detailsDiv = document.createElement('div');
      detailsDiv.className = 'listing-item-details';
      infoDiv.appendChild(detailsDiv);
      label.appendChild(infoDiv);
      div.appendChild(label);

      // Populate user-controlled content via safe DOM methods
      const imgSlot = div.querySelector('.listing-item-img-slot');
      const safeUrl = safeImageUrl(p.imageUrl);
      if (safeUrl) {
        const img = document.createElement('img');
        img.src = safeUrl;
        img.className = 'listing-item-img';
        img.alt = '';
        imgSlot.replaceWith(img);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'listing-item-img-placeholder';
        imgSlot.replaceWith(placeholder);
      }

      div.querySelector('.listing-item-title').textContent = p.productName || 'Sem nome';

      const metaEl = div.querySelector('.listing-item-meta');
      metaEl.querySelector('.listing-item-price').textContent = priceFormatted;
      if (origPriceFormatted) {
        const origSpan = document.createElement('span');
        origSpan.className = 'listing-item-orig-price';
        origSpan.textContent = origPriceFormatted;
        metaEl.appendChild(origSpan);
      }
      if (p.discountPercent) {
        const discSpan = document.createElement('span');
        discSpan.className = 'listing-item-discount';
        discSpan.textContent = `-${p.discountPercent}%`;
        metaEl.appendChild(discSpan);
      }

      const detailsEl = div.querySelector('.listing-item-details');
      if (p.seller) {
        const sellerSpan = document.createElement('span');
        sellerSpan.className = 'listing-item-seller';
        sellerSpan.textContent = p.seller;
        detailsEl.appendChild(sellerSpan);
      }
      if (p.freeShipping) {
        const shippingSpan = document.createElement('span');
        shippingSpan.className = 'listing-item-shipping';
        shippingSpan.textContent = 'Frete grátis';
        detailsEl.appendChild(shippingSpan);
      }
      saveListItemsContainer.appendChild(div);
    });

    loadListsDropdown();
  }

  // Update save list button state
  function updateSaveListBtnState() {
    const checked = document.querySelectorAll('.save-list-checkbox:checked').length;
    const hasListSelected = saveListSelect.value !== '';
    saveListSaveBtn.disabled = checked === 0 || !hasListSelected;
    saveListSaveBtn.textContent = checked > 0
      ? `Salvar ${checked} Selecionado${checked > 1 ? 's' : ''} na Lista`
      : 'Salvar Selecionados na Lista';
  }

  saveListItemsContainer.addEventListener('change', updateSaveListBtnState);
  saveListSelect.addEventListener('change', updateSaveListBtnState);

  saveListSelectAllBtn.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.save-list-checkbox');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => { cb.checked = !allChecked; });
    if (allChecked) {
      saveListSelectAllBtn.textContent = 'Selecionar Todos';
      saveListSelectAllBtn.classList.remove('btn-active');
    } else {
      saveListSelectAllBtn.textContent = 'Desmarcar Todos';
      saveListSelectAllBtn.classList.add('btn-active');
    }
    updateSaveListBtnState();
  });

  saveListNewBtn.addEventListener('click', () => {
    saveListNewInputRow.classList.remove('hidden');
    saveListNewName.focus();
  });

  saveListCancelBtn.addEventListener('click', () => {
    saveListNewInputRow.classList.add('hidden');
    saveListNewName.value = '';
  });

  saveListCreateBtn.addEventListener('click', async () => {
    const name = saveListNewName.value.trim();
    if (!name) { saveListNewName.focus(); return; }

    saveListCreateBtn.disabled = true;
    const result = await sendMessage({ action: 'createList', name });
    saveListCreateBtn.disabled = false;

    if (result?.success) {
      invalidateListsCache();
      saveListNewInputRow.classList.add('hidden');
      saveListNewName.value = '';
      await loadListsDropdown();
      // Auto-select the new list
      saveListSelect.value = result.data.id;
      updateSaveListBtnState();
      showToast(`Lista "${name}" criada`);
    } else if (result?.data?.existingList) {
      // Lista duplicada — oferecer usar a existente
      const existing = result.data.existingList;
      const useExisting = confirm(
        `Já existe uma lista "${existing.name}" com ${existing.activeItemCount ?? 0} produtos ativos.\n\nDeseja usar essa lista existente?`
      );
      if (useExisting) {
        saveListNewInputRow.classList.add('hidden');
        saveListNewName.value = '';
        await loadListsDropdown();
        saveListSelect.value = existing.id;
        updateSaveListBtnState();
        showToast(`Lista "${existing.name}" selecionada`);
      } else {
        saveListNewName.focus();
        saveListNewName.select();
      }
    } else {
      showToast(result?.error || 'Erro ao criar lista', 'error');
    }
  });

  // Save selected products to list — uses send queue for async processing
  saveListSaveBtn.addEventListener('click', async () => {
    const listId = parseInt(saveListSelect.value);
    console.log('[SidePanel:Lista] Save clicked. listId:', listId, 'selectValue:', saveListSelect.value);
    if (!listId || isNaN(listId)) {
      showToast('Selecione uma lista primeiro', 'error');
      return;
    }

    const checkboxes = document.querySelectorAll('.save-list-checkbox:checked');
    console.log('[SidePanel:Lista] Checked items:', checkboxes.length);
    if (checkboxes.length === 0) {
      showToast('Selecione pelo menos um produto', 'error');
      return;
    }

    const selectedProducts = Array.from(checkboxes).map(cb => {
      const idx = parseInt(cb.dataset.index);
      return { ...saveListProducts[idx], _idx: idx };
    });

    // Categoria na aba Listas é opcional: se vazia, usa o nome da lista selecionada
    // como categoria (backend aceita categoryName nulo, mas o nome da lista é um
    // agrupamento natural — o usuário já está selecionando a lista de destino).
    var listCategory = readCategoryFromPair('saveListCategorySelect', 'saveListCategoryInput');
    if (!listCategory) {
      var selectedOpt = saveListSelect.options[saveListSelect.selectedIndex];
      var fallbackName = selectedOpt ? (selectedOpt.text || '').split(' (')[0].trim() : '';
      listCategory = fallbackName || '';
    }

    const platform = detectPlatformFromData(selectedProducts[0] || null);

    // Prepare queue items with listId context
    const queueItems = selectedProducts.map(p => {
      const product = { ...p };
      product.categoryName = listCategory;
      return { product, platform, listId };
    });

    console.log(`[SidePanel:Lista] Adding ${queueItems.length} items to send queue (platform: ${platform}, listId: ${listId})`);

    const result = await sendMessage({
      action: 'sendQueue:add',
      items: queueItems,
    });

    if (result && result.success) {
      const listName = saveListSelect.options[saveListSelect.selectedIndex].text.split(' (')[0];
      showToast(`${queueItems.length} produto${queueItems.length > 1 ? 's' : ''} adicionado${queueItems.length > 1 ? 's' : ''} à fila para lista "${listName}"`);
      saveListSaveBtn.textContent = `${queueItems.length} na fila`;
      saveListSaveBtn.disabled = true;
      hideQueuePausedBanner();
      setTimeout(() => {
        saveListSaveBtn.disabled = false;
        saveListSaveBtn.textContent = 'Salvar Selecionados na Lista';
      }, 3000);
    } else {
      showToast(result?.error || 'Erro ao adicionar à fila', 'error');
    }
  });

  // Note: checkbox changes no longer auto-pause the send queue.
  // The queue processes items already added independently of user browsing.

  // ===== GERENCIAR LISTAS TAB =====

  async function loadListasTab() {
    listasLoading.classList.remove('hidden');
    listasEmpty.classList.add('hidden');
    listasContainer.classList.add('hidden');

    const result = await fetchListsCached();

    listasLoading.classList.add('hidden');

    if (!result?.success || !result.data || result.data.length === 0) {
      listasEmpty.classList.remove('hidden');
      return;
    }

    listasContainer.classList.remove('hidden');
    renderListas(result.data);
  }

  function renderListas(lists) {
    listasList.innerHTML = '';

    lists.forEach(list => {
      const card = document.createElement('div');
      card.className = 'lista-card';
      card.dataset.listId = list.id;

      card.innerHTML = `
        <div class="lista-card-header" data-action="toggle">
          <div class="lista-card-info">
            <div class="lista-card-name"></div>
            <div class="lista-card-meta">
              <span class="js-item-count"></span>
            </div>
          </div>
          <div class="lista-card-actions">
            <button class="btn-icon" data-action="rename" title="Renomear">✏️</button>
            <button class="btn-icon" data-action="delete" title="Excluir">🗑️</button>
          </div>
        </div>
        <div class="lista-card-items">
          <div class="empty-state" style="padding: 10px;"><p>Carregando...</p></div>
        </div>
      `;
      card.querySelector('.lista-card-name').textContent = list.name;
      card.querySelector('.js-item-count').textContent = `${list.activeItemCount || 0} ativos`;
      // Numa Lista Cupons os itens não envelhecem em 48 h — morrem junto com o cupom.
      // Mostrar ali "N expirando (mais de 48h)" seria informação falsa; o que importa
      // é a validade REAL da lista, que vem do banco e nunca do nome (R12 do plano).
      if (list.expiresAt) {
        const expires = new Date(list.expiresAt);
        const badge = document.createElement('span');
        const expired = expires.getTime() <= Date.now();
        badge.className = expired ? 'badge-expiring' : 'badge-coupon-list';
        badge.title = expired
          ? 'O cupom venceu: a lista e seus produtos são removidos na próxima limpeza'
          : 'Lista de cupom: os produtos valem até o cupom vencer';
        badge.textContent = expired
          ? '⚠️ cupom vencido'
          : `🎟️ vence ${expires.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
        card.querySelector('.lista-card-meta').appendChild(badge);
      } else if (list.expiringItemCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge-expiring';
        badge.title = 'Itens com mais de 48h serão removidos na próxima limpeza';
        badge.textContent = `⚠️ ${list.expiringItemCount} expirando`;
        card.querySelector('.lista-card-meta').appendChild(badge);
      }

      // Toggle expand
      card.querySelector('[data-action="toggle"]').addEventListener('click', async (e) => {
        if (e.target.closest('[data-action="rename"]') || e.target.closest('[data-action="delete"]')) return;

        const isExpanded = card.classList.contains('expanded');
        if (isExpanded) {
          card.classList.remove('expanded');
          return;
        }

        card.classList.add('expanded');
        const itemsDiv = card.querySelector('.lista-card-items');
        const itemsResult = await sendMessage({ action: 'getListItems', listId: list.id });

        if (itemsResult?.success && itemsResult.data?.length > 0) {
          itemsDiv.innerHTML = '';
          itemsResult.data.forEach(item => {
            const itemEl = document.createElement('div');
            itemEl.className = 'lista-item-mini';
            const priceStr = item.price ? `R$ ${(item.price / 100).toFixed(2).replace('.', ',')}` : '';
            if (item.imageUrl) {
              const img = document.createElement('img');
              img.src = item.imageUrl;
              img.className = 'lista-item-mini-img';
              img.alt = '';
              itemEl.appendChild(img);
            }
            const infoDiv = document.createElement('div');
            infoDiv.className = 'lista-item-mini-info';
            const nameDiv = document.createElement('div');
            nameDiv.className = 'lista-item-mini-name';
            nameDiv.textContent = item.productName || item.platformItemId;
            const priceDiv = document.createElement('div');
            priceDiv.className = 'lista-item-mini-price';
            priceDiv.textContent = priceStr;
            infoDiv.appendChild(nameDiv);
            infoDiv.appendChild(priceDiv);
            itemEl.appendChild(infoDiv);
            const removeBtn = document.createElement('button');
            removeBtn.className = 'lista-item-mini-remove';
            removeBtn.dataset.itemId = item.id;
            removeBtn.title = 'Remover';
            removeBtn.textContent = '✕';
            itemEl.appendChild(removeBtn);

            removeBtn.addEventListener('click', async (ev) => {
              ev.stopPropagation();
              const itemId = ev.target.dataset.itemId;
              const removeResult = await sendMessage({ action: 'removeListItem', listId: list.id, itemId: parseInt(itemId) });
              if (removeResult?.success) {
                itemEl.remove();
                showToast('Item removido');
              }
            });

            itemsDiv.appendChild(itemEl);
          });
        } else {
          itemsDiv.innerHTML = '<div class="empty-state" style="padding: 10px;"><p>Nenhum item</p></div>';
        }
      });

      // Rename
      card.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const nameEl = card.querySelector('.lista-card-name');
        const currentName = nameEl.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'lista-rename-input';
        input.value = currentName;
        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();

        const finishRename = async () => {
          const newName = input.value.trim();
          if (newName && newName !== currentName) {
            const result = await sendMessage({ action: 'renameList', listId: list.id, name: newName });
            if (result?.success) {
              invalidateListsCache();
              nameEl.textContent = newName;
              showToast('Lista renomeada');
            } else {
              nameEl.textContent = currentName;
            }
          } else {
            nameEl.textContent = currentName;
          }
        };

        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') { input.value = currentName; input.blur(); }
        });
      });

      // Delete
      card.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Excluir a lista "${list.name}"?`)) return;
        const result = await sendMessage({ action: 'deleteList', listId: list.id });
        if (result?.success) {
          invalidateListsCache();
          card.remove();
          showToast('Lista excluída');
          if (listasList.children.length === 0) {
            listasContainer.classList.add('hidden');
            listasEmpty.classList.remove('hidden');
          }
        } else {
          showToast(result?.error || 'Erro ao excluir', 'error');
        }
      });

      listasList.appendChild(card);
    });
  }

  // Load lista tab (combined) when clicked
  document.querySelector('[data-tab="lista"]').addEventListener('click', () => {
    loadListasTab();
    if (currentListingProducts && currentListingProducts.length > 0) {
      displaySaveListProducts(currentListingProducts);
    }
  });

  // Toggle collapsible sections
  document.getElementById('toggle-minhas-listas').addEventListener('click', () => {
    const body = document.getElementById('minhas-listas-body');
    const arrow = document.getElementById('minhas-listas-arrow');
    body.classList.toggle('collapsed');
    arrow.classList.toggle('collapsed');
  });

  document.getElementById('toggle-salvar-lista').addEventListener('click', () => {
    const body = document.getElementById('salvar-lista-body');
    const arrow = document.getElementById('salvar-lista-arrow');
    body.classList.toggle('collapsed');
    arrow.classList.toggle('collapsed');
  });

  // ===== COLLECT PAGE BUTTON (moved from automation tab to produto tab) =====

  const collectPageBtn = document.getElementById('collect-page-btn');

  collectPageBtn.addEventListener('click', async () => {
    if (!currentListingProducts || currentListingProducts.length === 0) return;

    collectPageBtn.disabled = true;
    collectPageBtn.textContent = '📦 Coletando...';

    const allProducts = currentListingProducts.map((p, i) => ({ ...p, index: i }));
    await saveSelectedProducts(allProducts);

    collectPageBtn.disabled = false;
    collectPageBtn.textContent = `📦 Coletar ${currentListingProducts.length} Produtos desta Página`;
  });

  // ===== CREATE LIST FROM KEYWORD =====

  const createListFromKwBtn = document.getElementById('create-list-from-kw-btn');
  const kwListDropdown = document.getElementById('kw-list-dropdown');
  const kwListSelect = document.getElementById('kw-list-select');
  const kwListConfirmBtn = document.getElementById('kw-list-confirm-btn');
  const kwListCancelBtn = document.getElementById('kw-list-cancel-btn');

  createListFromKwBtn.addEventListener('click', async () => {
    if (!kwListDropdown.classList.contains('hidden')) {
      kwListDropdown.classList.add('hidden');
      return;
    }

    // Fetch keyword groups and populate dropdown
    kwListSelect.innerHTML = '<option value="">Carregando...</option>';
    kwListDropdown.classList.remove('hidden');

    const result = await sendMessage({ action: 'getKeywordSearches' });
    const keywords = result?.data?.keywords || result?.keywords || [];

    kwListSelect.innerHTML = '<option value="">Selecione um grupo...</option>';
    if (keywords.length === 0) {
      kwListSelect.innerHTML = '<option value="">Nenhum grupo configurado</option>';
    } else {
      keywords.forEach(kw => {
        const opt = document.createElement('option');
        opt.value = kw.name;
        opt.textContent = `${kw.name} (${Array.isArray(kw.keywords) ? kw.keywords.length : 0} palavras)`;
        kwListSelect.appendChild(opt);
      });
    }
  });

  kwListConfirmBtn.addEventListener('click', async () => {
    const selectedName = kwListSelect.value;
    if (!selectedName) {
      alert('Selecione um grupo de palavras-chave.');
      return;
    }

    kwListConfirmBtn.disabled = true;
    kwListConfirmBtn.textContent = 'Criando...';

    const result = await sendMessage({ action: 'createList', name: selectedName });

    kwListConfirmBtn.disabled = false;
    kwListConfirmBtn.textContent = 'Criar Lista';

    if (result?.success) {
      invalidateListsCache();
      kwListDropdown.classList.add('hidden');
      showToast(`Lista "${selectedName}" criada`);
      loadListasTab();
      loadListsDropdown();
    } else if (result?.data?.existingList) {
      const existing = result.data.existingList;
      kwListDropdown.classList.add('hidden');
      showToast(`Lista "${existing.name}" já existe. Usando a existente.`, 'info');
      invalidateListsCache();
      loadListasTab();
      loadListsDropdown();
    } else {
      showToast(result?.error || 'Erro ao criar lista', 'error');
    }
  });

  kwListCancelBtn.addEventListener('click', () => {
    kwListDropdown.classList.add('hidden');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ABA "CUPONS" — Lista Cupons do Mercado Livre
  //
  // Código próprio de ponta a ponta: nenhuma função da aba "Lista" é reutilizada e
  // nenhuma classe CSS é compartilhada. O motivo não é purismo — o salvamento da
  // aba Lista faz `document.querySelectorAll('.save-list-checkbox:checked')`, que
  // varre o DOCUMENTO inteiro; reusar aquela classe aqui faria os produtos de cupom
  // entrarem no salvamento da outra aba.
  // ═══════════════════════════════════════════════════════════════════════════

  const cuponsOpenWebappBtn = document.getElementById('cupons-open-webapp-btn');
  const cuponsLoading = document.getElementById('cupons-loading');
  const cuponsEmpty = document.getElementById('cupons-empty');
  const cuponsList = document.getElementById('cupons-list');
  const cuponsSectionLista = document.getElementById('cupons-section-lista');
  const cuponsSectionProdutos = document.getElementById('cupons-section-produtos');
  const cuponsActiveBanner = document.getElementById('cupons-active-banner');
  const cuponsSuspensoAviso = document.getElementById('cupons-suspenso-aviso');
  const cuponsLimiteAviso = document.getElementById('cupons-limite-aviso');

  /**
   * Teto de produtos por envio.
   *
   * NÃO é um número escolhido para a tela: cada produto salvo exige um short link
   * meli.la gerado UM A UM pela fila, e lotes maiores fazem o ML barrar a geração.
   * A validação sempre existiu no clique de "Salvar" — o problema era só ela existir
   * lá: o usuário escolhia 80 produtos ao longo de várias páginas e só então descobria
   * que precisava desmarcar, sem nem saber quantos tinha marcado.
   */
  const MAX_SELECAO_CUPOM = 50;
  const cuponsListName = document.getElementById('cupons-list-name');
  const cuponsProductsItems = document.getElementById('cupons-products-items');
  const cuponsProductsCount = document.getElementById('cupons-products-count');
  const cuponsSelectAll = document.getElementById('cupons-select-all');
  const cuponsClearAll = document.getElementById('cupons-clear-all');
  const cuponsSaveBtn = document.getElementById('cupons-save-btn');
  const cuponsReconcileBtn = document.getElementById('cupons-reconcile-btn');

  // Regra do vínculo aba ↔ cupom, compartilhada com o service worker
  // (services/ml-coupon-tab-link.js). Nada aqui recalcula a chave do container.
  const CouponLink = globalThis.MlCouponTabLink;

  // Estado da aba. O acumulador SOMA entre paginadas — o usuário navega 1 → 2 → 3 e
  // os produtos das páginas anteriores não podem sumir.
  let activeCouponContext = null;   // { coupon, containerKey, tabId } da aba atual
  let couponScan = CouponLink.createAccumulator();
  let couponListId = null;          // lista já criada para o cupom ativo
  // Enquanto a varredura persistida é reidratada, eventos `offerExtracted` precisam
  // esperar. Sem esta barreira eles acumulavam no estado antigo e a leitura assíncrona
  // terminava depois, sobrescrevendo a primeira renderização com um snapshot vazio.
  let couponModeInitialization = null; // { context, promise }

  // A varredura é persistida POR ABA. O painel do Chrome é tab-specific (o service
  // worker chama sidePanel.setOptions por tabId a cada 'complete'), então este documento
  // é destruído e recriado toda vez que o usuário troca de aba — e o acumulador, que
  // vive em memória, ia junto. No 2º E2E de 26/jul/2026 isso era duplamente cruel: sair
  // da aba e voltar era exatamente o contorno que fazia os produtos aparecerem.
  const ML_COUPON_SCAN_KEY = 'mlCouponScan';

  async function saveCouponScan(context, scan) {
    const tabId = context?.tabId;
    if (tabId == null) return;
    // Captura ANTES do primeiro await. O usuário pode trocar de aba enquanto o storage
    // responde; reler os globals depois gravaria o cupom/scan novo sob o tabId antigo.
    const serialized = CouponLink.serializeScan(context.coupon.code, scan);
    try {
      const stored = await chrome.storage.session.get(ML_COUPON_SCAN_KEY);
      const map = stored?.[ML_COUPON_SCAN_KEY] || {};
      map[String(tabId)] = serialized;
      await chrome.storage.session.set({ [ML_COUPON_SCAN_KEY]: map });
    } catch (e) {
      console.warn('[SidePanel:Cupons] Falha ao persistir a varredura:', e.message);
    }
  }

  async function loadCouponScan(tabId, code) {
    try {
      const stored = await chrome.storage.session.get(ML_COUPON_SCAN_KEY);
      const map = stored?.[ML_COUPON_SCAN_KEY] || {};
      // restoreScan devolve acumulador VAZIO se a varredura salva for de outro cupom —
      // reidratar produtos de outro cupom aqui anunciaria desconto que eles não têm.
      return CouponLink.restoreScan(map[String(tabId)], code);
    } catch {
      return CouponLink.createAccumulator();
    }
  }

  function couponPriceLabel(cents) {
    return cents ? `R$ ${(cents / 100).toFixed(2).replace('.', ',')}` : '';
  }

  function renderCouponCards(coupons) {
    cuponsList.innerHTML = '';
    coupons.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'lista-card';

      const header = document.createElement('div');
      header.className = 'lista-card-header';

      const info = document.createElement('div');
      info.className = 'lista-card-info';

      const name = document.createElement('div');
      name.className = 'lista-card-name';
      name.textContent = c.code;
      info.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'lista-card-meta';
      const parts = [];
      if (c.discountRaw) parts.push(c.discountRaw);
      if (c.expirationRaw) parts.push(c.expirationRaw);
      if (c.budgetRemainingCents != null) parts.push('Saldo ' + couponPriceLabel(c.budgetRemainingCents));
      meta.textContent = parts.join(' · ');
      info.appendChild(meta);

      // Condições do cupom, como o servidor as interpretou. Elas não existem no card do
      // ML: moram no modal, e quem as lê é o parser do servidor — por isso só aparecem
      // depois que a sincronização grava. São as MESMAS regras que decidem o preço
      // anunciado na mensagem de envio, então o usuário precisa vê-las aqui, antes de
      // montar a lista, e não descobrir no envio que o cupom não fecha conta.
      if (c.conditionsParsed) {
        const regras = [];
        if (c.minPurchaseCents) regras.push('mín. ' + couponPriceLabel(c.minPurchaseCents));
        if (c.maxDiscountCents) regras.push('teto ' + couponPriceLabel(c.maxDiscountCents));
        if (c.validUntil) {
          const d = new Date(c.validUntil);
          if (!isNaN(d.getTime())) {
            regras.push('vence ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }));
          }
        }
        if (regras.length) {
          const cond = document.createElement('div');
          cond.className = 'lista-card-meta';
          cond.textContent = '✅ ' + regras.join(' · ');
          info.appendChild(cond);
        }
      }

      // O aviso ramifica por `conditionsParsed` (veredito do SERVIDOR), não por
      // `rawText`: com o texto capturado mas incompreensível para o parser, o cupom
      // fica igualmente sem preço — e dizer "não lidas" quando o servidor já tem as
      // condições de uma sincronização anterior seria mentira.
      if (!c.conditionsParsed) {
        // Duas consequências, e as duas aparecem só depois — daí o aviso aqui:
        // (1) a mensagem sai com o código e SEM preço, porque o desconto depende do
        //     mínimo e do teto do modal;
        // (2) o vencimento com ANO também mora no modal, então a lista fica sem
        //     validade de cupom e seus produtos seguem a regra normal de 48 h.
        const warn = document.createElement('div');
        warn.className = 'lista-card-meta';
        warn.textContent = c.rawText
          ? '⚠️ Condições não interpretadas: o texto do cupom foi lido, mas o servidor ' +
            'não achou nele o mínimo/teto. A mensagem sai sem o preço com desconto.'
          : '⚠️ Condições não lidas (o modal "Condições do cupom" não abriu): a mensagem ' +
            'sai sem o preço com desconto e a lista não herda o vencimento do cupom ' +
            '(produtos valem 48 h). Sincronize de novo.';
        info.appendChild(warn);
      }

      if (!c.productsUrl) {
        // O ML às vezes entrega o "Ver produtos" como <a> SEM href — o link funciona
        // no clique, mas a URL não existe no DOM para a extensão copiar. Sem ela não dá
        // para abrir a aba nem, principalmente, derivar a chave que amarra os produtos a
        // ESTE cupom. O caminho manual abaixo preserva essa amarração: quem navega é o
        // usuário, e a extensão lê a chave da URL real da aba.
        const warnUrl = document.createElement('div');
        warnUrl.className = 'lista-card-meta';
        warnUrl.textContent =
          'ℹ️ O Mercado Livre não expôs o link deste cupom. Clique em "Ver produtos" na ' +
          'página do ML e, com a listagem aberta, use "Vincular esta aba" aqui.';
        info.appendChild(warnUrl);
      }

      header.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'lista-card-actions';
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.textContent = c.productsUrl ? 'Ver produtos' : 'Vincular esta aba';
      btn.dataset.testid = c.productsUrl
        ? `button-coupon-products-${c.code}`
        : `button-coupon-attach-${c.code}`;
      btn.addEventListener('click', () => (c.productsUrl ? openCouponProducts(c) : attachCouponToTab(c)));
      actions.appendChild(btn);
      header.appendChild(actions);

      card.appendChild(header);
      cuponsList.appendChild(card);
    });
  }

  /**
   * Lista os cupons da ÚLTIMA sincronização — o painel não sincroniza mais.
   *
   * A sincronização passou a ter um lugar só, a página Cupons do web app: o mesmo botão
   * em dois lugares era duas portas para o mesmo fluxo, e a do painel ainda dava a
   * impressão de que era preciso sincronizar de novo depois de já ter sincronizado lá.
   *
   * A lista continua aqui porque é ela que dá acesso ao caminho manual "Vincular esta
   * aba" — a saída para o cupom cujo link o ML não expõe.
   */
  async function loadCouponCards() {
    const result = await sendMessage({ action: 'getMlCouponsCache' });
    const coupons = (result?.success && result.data?.coupons) || [];

    cuponsLoading.classList.add('hidden');
    if (coupons.length === 0) {
      cuponsList.classList.add('hidden');
      cuponsEmpty.classList.remove('hidden');
      return;
    }
    cuponsEmpty.classList.add('hidden');
    cuponsList.classList.remove('hidden');
    renderCouponCards(coupons);
  }

  async function openCouponProducts(coupon) {
    // O vínculo aba → cupom é registrado pelo service worker: a URL de destino não
    // carrega o código do cupom, então este clique é a única fonte da ligação.
    const result = await sendMessage({ action: 'openMlCouponProducts', coupon });
    if (!result?.success) {
      showToast(result?.error || 'Não foi possível abrir os produtos do cupom', 'error');
      return;
    }
    showToast(`Abrindo os produtos do cupom ${coupon.code}…`);
  }

  /**
   * Vincula o cupom à aba que o usuário já abriu — usado quando o ML não expôs o href
   * do "Ver produtos". O service worker recusa o vínculo se a aba não estiver numa
   * listagem `_Container_`, e é essa recusa que impede produtos sem direito ao desconto
   * de entrarem na lista do cupom.
   */
  async function attachCouponToTab(coupon) {
    const result = await sendMessage({ action: 'attachMlCouponToTab', coupon });
    if (!result?.success) {
      showToast(result?.error || 'Não foi possível vincular esta aba ao cupom', 'error');
      return;
    }
    showToast(`Aba vinculada ao cupom ${coupon.code}`);
    // Entra no modo "Produtos do cupom" na hora. Sem isto o usuário vincularia e
    // continuaria olhando a lista de cupons, sem sinal de que deu certo — e os produtos
    // só apareceriam na próxima navegação dentro da listagem.
    await handleCouponTabEvent(result.data.tabId, result.data.productsUrl, null);

    // E pede a extração da página que JÁ está aberta — mesma razão do bloco do
    // DOMContentLoaded: o `offerExtracted` daquela listagem foi emitido pelo content
    // script ~1 s depois do load, quando ainda não existia cupom vinculado à aba, e
    // nada reextrai sem navegação. Sem este pedido o painel entraria com 0 produtos e
    // o "Salvar" responderia "Selecione pelo menos um produto" — parecendo que o
    // vínculo falhou. Pior: essa página ficaria de fora do manifesto e a reconciliação
    // podaria da lista itens legítimos.
    try {
      // A extração vai para a aba ATIVA no momento da chamada, não para um tabId. O
      // contexto ativo só existe se ela for a aba do cupom (resolveCouponTabContext
      // recusa qualquer outra), e é essa recusa que impede produtos de OUTRA listagem
      // de entrarem neste cupom.
      if (activeCouponContext && activeCouponContext.tabId === result.data.tabId) {
        await pullCouponProducts(activeCouponContext);
      }
    } catch (e) {
      console.warn('[SidePanel:Cupons] Falha ao extrair a página vinculada:', e.message);
    }
  }

  /** Nome sugerido: CODIGO-DD/MM, editável. Espelha suggestCouponListName do servidor. */
  function suggestListName(coupon) {
    return CouponLink.suggestListName(coupon.code, coupon.expirationRaw);
  }

  function couponCheckboxes() {
    return Array.prototype.slice.call(cuponsProductsItems.querySelectorAll('.coupon-list-checkbox'));
  }

  function couponCheckedCount() {
    return cuponsProductsItems.querySelectorAll('.coupon-list-checkbox:checked').length;
  }

  /**
   * Contagem viva do que está marcado + trava do teto.
   *
   * Três coisas que só existem juntas: o contador (`12/50 selecionados`), o
   * `disabled` nos não marcados quando o teto chega, e o aviso dizendo o que fazer. Sem
   * o contador o usuário não sabe onde está; sem a trava ele passa do teto sem perceber;
   * sem o aviso a trava vira um checkbox que "não funciona".
   */
  function updateCouponSelectionState() {
    const total = couponScan.products.length;
    const marcados = couponCheckedCount();
    const noTeto = marcados >= MAX_SELECAO_CUPOM;

    cuponsProductsCount.textContent =
      `${total} produto${total === 1 ? '' : 's'} · ${marcados}/${MAX_SELECAO_CUPOM} selecionados`;

    // Só os NÃO marcados travam: desmarcar precisa continuar possível, senão o usuário
    // fica preso no teto sem poder trocar um produto por outro.
    couponCheckboxes().forEach((b) => { b.disabled = noTeto && !b.checked; });

    if (cuponsLimiteAviso) {
      cuponsLimiteAviso.classList.toggle('hidden', !noTeto);
      cuponsLimiteAviso.textContent = noTeto
        ? `⚠️ Limite de ${MAX_SELECAO_CUPOM} produtos por envio. Salve estes na Lista Cupons ` +
          'e depois continue marcando os próximos — a lista acumula, nada se perde.'
        : '';
    }

    cuponsSaveBtn.textContent = marcados > 0
      ? `Salvar ${marcados} na Lista Cupons`
      : 'Salvar selecionados na Lista Cupons';
  }

  function renderCouponProducts() {
    const couponProducts = couponScan.products;
    // ⚠️ As marcações sobrevivem ao re-render. Ele acontece a cada página nova que chega,
    // e recriar os checkboxes limpos jogava fora a escolha que o usuário tinha acabado de
    // fazer na página anterior — justamente no fluxo "marque, salve, continue".
    const marcadosAntes = new Set(
      couponCheckboxes()
        .filter((b) => b.checked)
        .map((b) => CouponLink.couponProductKey(couponProducts[parseInt(b.dataset.index, 10)]))
        .filter(Boolean),
    );
    cuponsProductsItems.innerHTML = '';

    couponProducts.forEach((p, idx) => {
      const label = document.createElement('label');
      label.className = 'listing-item-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      // Classe PRÓPRIA — ver o comentário do topo deste bloco.
      checkbox.className = 'coupon-list-checkbox';
      checkbox.dataset.index = idx;
      const chave = CouponLink.couponProductKey(p);
      if (chave && marcadosAntes.has(chave)) checkbox.checked = true;
      label.appendChild(checkbox);

      const safeUrl = safeImageUrl(p.imageUrl);
      if (safeUrl) {
        const img = document.createElement('img');
        img.src = safeUrl;
        img.className = 'listing-item-img';
        img.alt = '';
        label.appendChild(img);
      }

      const info = document.createElement('div');
      info.className = 'listing-item-info';
      const title = document.createElement('div');
      title.className = 'listing-item-title';
      title.textContent = p.productName || 'Produto';
      info.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'listing-item-meta';
      const price = document.createElement('span');
      price.className = 'listing-item-price';
      price.textContent = couponPriceLabel(p.price);
      meta.appendChild(price);

      // Paridade com o card da aba Listas (displaySaveListProducts): preço cheio
      // riscado + badge de desconto.
      //
      // Estes campos SEMPRE estiveram no objeto — o modo cupom e a aba Listas consomem
      // o MESMO evento `offerExtracted`, e a fila já grava os dois no banco
      // (send-queue.js: originalPrice/discountPercent). Só este renderizador não os lia,
      // e o card do cupom mostrava um número só: o usuário não distinguia produto em
      // promoção de produto no preço normal antes de escolher o que salvar.
      //
      // As classes já existem no sidepanel.css e são globais — nada de CSS novo.
      if (p.originalPrice && p.originalPrice > p.price) {
        const origPrice = document.createElement('span');
        origPrice.className = 'listing-item-orig-price';
        origPrice.textContent = couponPriceLabel(p.originalPrice);
        meta.appendChild(origPrice);
      }
      if (p.discountPercent) {
        const disc = document.createElement('span');
        disc.className = 'listing-item-discount';
        disc.textContent = `-${p.discountPercent}%`;
        meta.appendChild(disc);
      }

      info.appendChild(meta);
      label.appendChild(info);

      const item = document.createElement('div');
      item.className = 'listing-item';
      item.appendChild(label);
      cuponsProductsItems.appendChild(item);
    });

    updateCouponSelectionState();
  }

  /** Acumula produtos da página atual, deduplicando por MLB. Devolve quantos entraram. */
  function accumulateCouponProducts(products) {
    const added = CouponLink.accumulate(couponScan, products);
    if (added > 0) {
      renderCouponProducts();
      // Sem await: persistir é rede de segurança contra o remount do painel, não parte
      // do caminho crítico do usuário.
      saveCouponScan(activeCouponContext, couponScan);
    }
    return added;
  }

  /**
   * "Mesmo cupom" inclui a ABA e o container.
   *
   * Comparar só `coupon.code` reutilizava o acumulador da aba anterior quando o usuário
   * clicava novamente em "Ver produtos" para o mesmo cupom. Nesse caso os produtos eram
   * persistidos sob o tabId antigo e o painel novo nascia dessincronizado.
   */
  function sameCouponContext(a, b) {
    return !!(
      a &&
      b &&
      a.tabId === b.tabId &&
      a.containerKey === b.containerKey &&
      a.coupon?.code === b.coupon?.code
    );
  }

  /**
   * Diz na tela por que os produtos não estão entrando.
   *
   * O estado suspenso é legítimo (o usuário abriu a PDP de um produto, foi para a busca),
   * mas também é o que aparece quando o ML muda o formato da URL da listagem — e aí o
   * painel ficava mudo, parecendo quebrado. As duas chaves lado a lado são o diagnóstico
   * inteiro: se a atual for "—", a página não é listagem de cupom nenhuma; se for outra
   * chave, o ML trocou a rota.
   */
  function renderCouponSuspendedWarning(context) {
    if (!cuponsSuspensoAviso) return;
    if (!context || !context.suspenso) {
      cuponsSuspensoAviso.classList.add('hidden');
      cuponsSuspensoAviso.textContent = '';
      return;
    }
    cuponsSuspensoAviso.classList.remove('hidden');
    cuponsSuspensoAviso.textContent =
      '⏸️ Esperando a listagem do cupom ' + context.coupon.code + '. Esta aba está em ' +
      'outra página, então nada é acumulado. (esperada: ' + (context.containerKey || '—') +
      ' · atual: ' + (context.chaveAtual || '—') + ')';
    console.warn(
      '[SidePanel:Cupons] vínculo suspenso — url:', context.urlAtual,
      '| chave atual:', context.chaveAtual, '| chave esperada:', context.containerKey,
    );
  }

  async function enterCouponProductsMode(context) {
    activeCouponContext = context;
    const promise = (async () => {
      // Reidrata a varredura desta aba em vez de zerar. Zerar aqui apagava tudo que o
      // usuário já tinha acumulado paginando, toda vez que o painel remontava.
      const restoredScan = await loadCouponScan(context.tabId, context.coupon.code);

      // Outra aba/cupom pode ter virado o contexto ativo enquanto o storage respondia.
      // A inicialização antiga não pode sobrescrever o painel novo.
      if (!sameCouponContext(activeCouponContext, context)) return false;

      couponScan = restoredScan;
      couponListId = null;

      cuponsSectionLista.classList.add('hidden');
      cuponsSectionProdutos.classList.remove('hidden');
      cuponsActiveBanner.textContent =
        `Cupom ${context.coupon.code}` +
        (context.coupon.discountRaw ? ` · ${context.coupon.discountRaw}` : '') +
        (context.coupon.expirationRaw ? ` · ${context.coupon.expirationRaw}` : '');
      cuponsListName.value = suggestListName(context.coupon);
      renderCouponSuspendedWarning(context);
      renderCouponProducts();
      switchTab('cupons');
      return true;
    })();

    couponModeInitialization = { context, promise };
    try {
      return await promise;
    } finally {
      // Uma inicialização mais nova pode ter começado enquanto esta aguardava o storage.
      if (couponModeInitialization?.promise === promise) couponModeInitialization = null;
    }
  }

  /**
   * Garante que o acumulador do contexto já foi reidratado antes de receber produtos.
   * Chamadas concorrentes para a mesma aba compartilham a mesma Promise.
   */
  async function ensureCouponProductsMode(context) {
    if (!sameCouponContext(activeCouponContext, context)) {
      return enterCouponProductsMode(context);
    }
    if (
      couponModeInitialization &&
      sameCouponContext(couponModeInitialization.context, context)
    ) {
      return couponModeInitialization.promise;
    }
    return true;
  }

  /**
   * Cria a Lista Cupons no servidor (ou reencontra a existente) e devolve o id.
   *
   * Quem manda o texto bruto das condições é aqui: mínimo, teto, tipo/valor e
   * vencimento são derivados no SERVIDOR, a partir de `rawText`.
   */
  async function ensureCouponList() {
    if (couponListId) return couponListId;
    const c = activeCouponContext.coupon;
    const result = await sendMessage({
      action: 'createCouponList',
      name: (cuponsListName.value || '').trim() || suggestListName(c),
      coupon: {
        code: c.code,
        marketplace: 'ml',
        couponCategory: c.couponCategory || null,
        discountType: c.discountType || null,
        discountValue: c.discountValue || null,
        rawText: c.rawText || null,
        productsUrl: c.productsUrl || null,
        budgetRemainingCents: c.budgetRemainingCents ?? null,
      },
    });
    if (!result?.success) {
      showToast(result?.error || 'Erro ao criar a Lista Cupons', 'error');
      return null;
    }
    couponListId = result.data?.id ?? null;
    if (result.data?.warnings?.length) {
      // O usuário precisa VER a ressalva: "vencimento veio do card" e "validade
      // truncada em 90 dias" mudam quando a lista morre. Só no console, ele
      // descobriria pela lista esvaziando sem explicação.
      console.warn('[SidePanel:Cupons] Ressalvas do servidor:', result.data.warnings);
      showToast(`Atenção: ${result.data.warnings[0]}`, 'error');
    }
    return couponListId;
  }

  cuponsOpenWebappBtn.addEventListener('click', async () => {
    // Leva ao ÚNICO lugar onde se sincroniza. Mesma resolução de ambiente do resto do
    // painel: em dev o web app não é achadinhopro.com.br.
    let baseUrl = 'https://achadinhopro.com.br';
    try {
      const config = await chrome.storage.local.get(['apiBaseUrl', 'apiEnvironment']);
      baseUrl =
        config.apiBaseUrl ||
        (config.apiEnvironment === 'dev'
          ? 'https://6e7556a0-df58-4384-bca5-2148dbe3e669-00-mo2oldg3hq8g.worf.replit.dev'
          : baseUrl);
    } catch { /* storage indisponível: prod é o padrão certo */ }
    chrome.tabs.create({ url: `${baseUrl}/cupons` });
  });

  // Delegação: os checkboxes são recriados a cada página nova que chega, e um listener
  // por checkbox morreria junto com eles.
  cuponsProductsItems.addEventListener('change', (ev) => {
    const alvo = ev.target;
    if (!alvo || !alvo.classList || !alvo.classList.contains('coupon-list-checkbox')) return;
    // O `disabled` é a trava principal; esta é a rede para o que ele não cobre (teclado,
    // marcação programática, e o clique que chega no mesmo instante do 50º).
    if (alvo.checked && couponCheckedCount() > MAX_SELECAO_CUPOM) {
      alvo.checked = false;
      showToast(`Limite de ${MAX_SELECAO_CUPOM} por envio — salve os marcados e continue`, 'error');
    }
    updateCouponSelectionState();
  });

  // Botão próprio para desmarcar. "Selecionar todos" alternava, mas alternar só é
  // descobrível depois de já ter marcado tudo — e no teto de 50, com metade da lista
  // travada, "clique de novo para desmarcar" deixa de ser óbvio.
  cuponsClearAll.addEventListener('click', () => {
    couponCheckboxes().forEach((b) => { b.checked = false; });
    updateCouponSelectionState();
  });

  cuponsSelectAll.addEventListener('click', () => {
    const boxes = couponCheckboxes();
    const allChecked = boxes.length > 0 && boxes.every((b) => b.checked);
    if (allChecked) {
      boxes.forEach((b) => { b.checked = false; });
      updateCouponSelectionState();
      return;
    }
    // Marca até o teto, na ordem da tela. Marcar tudo e deixar o clique em "Salvar"
    // reclamar é o comportamento antigo, que é o que gerou este ajuste.
    let marcados = couponCheckedCount();
    let ficaramDeFora = 0;
    for (const b of boxes) {
      if (b.checked) continue;
      if (marcados >= MAX_SELECAO_CUPOM) { ficaramDeFora += 1; continue; }
      b.checked = true;
      marcados += 1;
    }
    updateCouponSelectionState();
    if (ficaramDeFora > 0) {
      showToast(
        `Marcados ${MAX_SELECAO_CUPOM} (o máximo por envio). Faltaram ${ficaramDeFora} — salve estes e marque o resto depois.`,
      );
    }
  });

  cuponsSaveBtn.addEventListener('click', async () => {
    if (!activeCouponContext) return;
    // Escopado ao container da aba, não ao documento.
    const checked = cuponsProductsItems.querySelectorAll('.coupon-list-checkbox:checked');
    if (checked.length === 0) {
      showToast('Selecione pelo menos um produto', 'error');
      return;
    }
    // Rede de segurança: a tela já trava a marcação no teto (updateCouponSelectionState).
    // A contagem é de PRODUTOS selecionados, nunca de páginas.
    if (checked.length > MAX_SELECAO_CUPOM) {
      showToast(`Selecione no máximo ${MAX_SELECAO_CUPOM} produtos por vez`, 'error');
      return;
    }

    cuponsSaveBtn.disabled = true;
    const listId = await ensureCouponList();
    if (!listId) { cuponsSaveBtn.disabled = false; return; }

    const selected = Array.prototype.map.call(checked, (cb) => couponScan.products[parseInt(cb.dataset.index, 10)]);
    // A fila resolve persistência e link de afiliado (um por produto, com retry).
    const queueItems = selected.map((p) => ({ product: { ...p }, platform: 'ml', listId }));

    const result = await sendMessage({ action: 'sendQueue:add', items: queueItems });
    cuponsSaveBtn.disabled = false;

    if (result?.success) {
      showToast(
        `${queueItems.length} produto${queueItems.length > 1 ? 's' : ''} na fila para a Lista Cupons` +
          ' — pode continuar marcando os próximos',
      );
      checked.forEach((cb) => { cb.checked = false; });
      // Libera o teto na hora: sem isto os checkboxes continuariam desabilitados depois
      // do envio, e o usuário acharia que a extensão travou.
      updateCouponSelectionState();
    } else {
      showToast(result?.error || 'Erro ao adicionar à fila', 'error');
    }
  });

  cuponsReconcileBtn.addEventListener('click', async () => {
    if (!activeCouponContext) return;
    const listId = await ensureCouponList();
    if (!listId) return;

    // Reconciliação só com o manifesto do que está ACUMULADO — que é o resultado da
    // varredura que o usuário fez. Manifesto vazio nunca esvazia a lista.
    // Os ids vão NORMALIZADOS (MLB1234567, sem hífen): o servidor compara pelo mesmo
    // formato, e um `MLB-1234567` fora de padrão faria a lista perder item elegível.
    const eligibleItemIds = couponScan.products.map(CouponLink.couponProductKey).filter(Boolean);
    if (eligibleItemIds.length === 0) {
      showToast('Nenhum produto lido ainda — navegue pelas páginas do cupom antes', 'error');
      return;
    }
    const ok = confirm(
      `Isto REMOVE da lista os produtos que não estiverem entre os ${eligibleItemIds.length} lidos.\n\n` +
      'Só confirme se você percorreu TODAS as páginas do cupom.',
    );
    if (!ok) return;

    cuponsReconcileBtn.disabled = true;
    const result = await sendMessage({
      action: 'reconcileCouponList',
      listId,
      eligibleItemIds,
      importId: `${activeCouponContext.coupon.code}-${Date.now()}`,
    });
    cuponsReconcileBtn.disabled = false;

    if (result?.success) {
      showToast(`Lista sincronizada — ${result.data?.removed ?? 0} produto(s) removido(s)`);
    } else {
      showToast(result?.error || 'Erro ao sincronizar a lista', 'error');
    }
  });

  document.querySelector('[data-tab="cupons"]').addEventListener('click', () => {
    // Fora do modo produtos, a aba lista os cupons da última sincronização. Recarregar a
    // cada clique é barato (uma leitura de storage) e evita a tela mostrar um retrato
    // velho depois de o usuário sincronizar no web app com o painel já aberto.
    if (!activeCouponContext) {
      loadCouponCards().catch((e) =>
        console.warn('[SidePanel:Cupons] Falha ao listar os cupons:', e?.message || e),
      );
    }
  });

  /**
   * A aba está na listagem de produtos de um cupom? Devolve o contexto ou null.
   *
   * O vínculo vem do service worker (registro tabId → cupom), nunca da URL: a URL
   * `_Container_<slug>-seller-<id>` não cita o cupom, e ela ainda muda a cada
   * paginada. Por isso a continuidade é conferida pela chave estável (slug,
   * sellerId), não pela URL inteira.
   */
  async function resolveCouponTabContext(tabId, url) {
    if (tabId == null) return null;

    // Só a aba em FOCO. Com duas abas de cupons abertas, um evento da aba de fundo
    // faria os produtos de um cupom entrarem na Lista Cupons do outro.
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab || activeTab.id !== tabId) return null;
      if (!url) url = activeTab.url;
    } catch {
      return null;
    }

    const result = await sendMessage({ action: 'getMlCouponTabContext', tabId });
    const context = result?.success ? result.data : null;
    if (!context) return null;

    // Fora da listagem (PDP de um produto, busca, home) o vínculo fica em SUSPENSO:
    // não é apagado — voltar restaura —, mas nada é acumulado enquanto está fora.
    //
    // ⚠️ SUSPENSO NÃO É "SEM VÍNCULO", e tratar os dois como `null` custou caro: o painel
    // abria na aba Produtos e ficava mudo, sem dizer que estava esperando a listagem
    // daquele cupom. Agora o contexto volta marcado — quem acumula produto exige
    // `!suspenso`, quem só monta a tela (aba Cupons, banner, nome da lista) não precisa.
    context.tabId = tabId;
    context.suspenso = CouponLink.containerState(url, context.containerKey) !== 'match';
    // Guardado para o aviso: as duas chaves lado a lado são o diagnóstico inteiro quando
    // o ML muda o formato da URL da listagem.
    context.urlAtual = url || null;
    context.chaveAtual = CouponLink.containerKeyFromUrl(url) || null;
    return context;
  }

  /**
   * Traz os produtos da listagem para o painel que acabou de montar.
   *
   * Duas fontes, e as duas são necessárias: `pendingProducts` é o que o service worker
   * extraiu enquanto este documento nem existia (ver primeMlCouponTab no service
   * worker), e o `extractOffer` cobre o painel aberto depois, com o usuário já noutra
   * página da listagem. O retry existe porque a listagem do ML hidrata em duas etapas —
   * extrair cedo demais devolve zero produto, indistinguível de "listagem vazia".
   */
  // Página que já está sendo lida agora. `tabUpdated` e `pageChanged` chegam quase
  // juntos na mesma navegação, e cada leitura custa até 3 tentativas × 1,5 s no service
  // worker — sem esta trava a paginação dispararia leituras empilhadas da mesma página.
  let couponPullEmCurso = null;

  async function pullCouponProductsOnce(context) {
    const chave = context.tabId + '|' + (context.urlAtual || '');
    if (couponPullEmCurso === chave) return;
    couponPullEmCurso = chave;
    try {
      await pullCouponProducts(context);
    } finally {
      if (couponPullEmCurso === chave) couponPullEmCurso = null;
    }
  }

  async function pullCouponProducts(context) {
    if (Array.isArray(context.pendingProducts) && context.pendingProducts.length > 0) {
      accumulateCouponProducts(context.pendingProducts);
    }

    // ⚠️ A extração é roteada por tabId + containerKey (`extractCouponTabOffer`), NUNCA
    // pela aba ativa: entre as tentativas há espera, e nesse intervalo a aba ativa pode
    // ser outra — inclusive em outra janela, onde `currentWindow` do service worker
    // resolveria para a janela errada. Acumular a listagem de outra página aqui colocaria
    // na Lista Cupons produto sem direito ao desconto.
    //
    // A página corrente é lida SEMPRE, mesmo com varredura restaurada não vazia: o
    // usuário pode ter aberto a página 3 e trocado de aba antes do `offerExtracted`
    // (disparo único do content script). Guardar-se com `products.length === 0` deixaria
    // essa página de fora — e ela sairia também do manifesto da reconciliação, que então
    // podaria da lista itens legítimos. O dedup por MLB cobre a releitura.
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const r = await sendMessage({
        action: 'extractCouponTabOffer',
        tabId: context.tabId,
        containerKey: context.containerKey,
      });
      if (!r?.success) break;
      // Saiu da listagem deste cupom: parar é o comportamento correto, e não é uma falha
      // transitória que valha retentar.
      if (r.data?.mismatch) break;
      const products = r.data?.products;
      if (Array.isArray(products) && products.length > 0) {
        accumulateCouponProducts(products);
        break;
      }
    }
  }

  /**
   * Um evento de navegação chegou. Entra no modo "produtos do cupom" se ainda não
   * estiver, e acumula os produtos que vierem junto.
   *
   * Quem traz os produtos é o `offerExtracted` do content script, e não uma extração
   * disparada daqui: o scraper do ML já reextrai com retry a cada navegação, e pedir
   * `extractOffer` no `complete` pegava o React no meio da hidratação (listagem
   * vazia). Os eventos sem produto (`pageChanged`, `tabUpdated`) servem só para abrir
   * a aba com o nome pré-preenchido antes de os produtos chegarem.
   */
  async function handleCouponTabEvent(tabId, url, products) {
    const context = await resolveCouponTabContext(tabId, url);
    if (!context) return;

    // O evento com produtos pode chegar enquanto a leitura do storage ainda está em
    // curso. Só acumula depois que o estado inicial da MESMA aba estiver pronto.
    if (!(await ensureCouponProductsMode(context))) return;
    renderCouponSuspendedWarning(context);
    // Suspenso: a tela fica montada (aba Cupons, banner, nome da lista), mas produto NÃO
    // entra — seriam itens de outra página dentro da Lista Cupons deste cupom.
    if (context.suspenso) return;

    if (!Array.isArray(products)) {
      // ⚠️ EVENTO DE NAVEGAÇÃO SEM PRODUTOS (`tabUpdated`, `pageChanged`) — é o que chega
      // quando o usuário clica na paginação da listagem. Aqui o painel esperava,
      // passivamente, o `offerExtracted` do content script; e esse é DISPARO ÚNICO, 1 s
      // depois do load. Quando ele não vem (ou chega antes de este documento estar
      // ouvindo, porque o painel remonta a cada 'complete'), a página nova simplesmente
      // não entrava: o usuário paginava e a Lista Cupons ficava parada na página 1, sem
      // erro nenhum na tela.
      //
      // O boot já lia a página ativamente — `pullCouponProducts`, roteado por
      // tabId + containerKey e com retry. A navegação passa a fazer o mesmo. Se o
      // `offerExtracted` também chegar, o dedup por MLB cobre a releitura.
      await pullCouponProductsOnce(context);
      return;
    }
    const added = accumulateCouponProducts(products);
    if (added > 0) showToast(`+${added} produto(s) do cupom ${context.coupon.code}`);
  }

  chrome.runtime.onMessage.addListener((message) => {
    // `offerExtracted` é o que traz produto — e é o ÚNICO evento que chega quando a
    // paginação do ML é navegação de documento (`_Desde_49` é um <a href>, não SPA):
    // ali `pageChanged` nunca dispara, porque quem o emite é o observador de URL do
    // content script, que morre com o documento antigo.
    // O `.catch` não é decoração: um erro aqui (aba fechada no meio, service worker
    // reciclado) viraria unhandled rejection e derrubaria o tratamento dos eventos
    // seguintes — a aba pararia de acumular sem nenhum sinal para o usuário.
    const onCouponEvent = (tabId, url, products) =>
      handleCouponTabEvent(tabId, url, products).catch((e) =>
        console.warn('[SidePanel:Cupons] Falha ao tratar evento de navegação:', e?.message || e),
      );

    if (message.action === 'offerExtracted') {
      onCouponEvent(message.sourceTabId, message.url, Array.isArray(message.data) ? message.data : null);
      return;
    }
    // Navegação SPA dentro da listagem (filtros, ordenação).
    if (message.action === 'pageChanged') {
      onCouponEvent(message.sourceTabId, message.url, null);
      return;
    }
    // O service worker reconciliou a chave do vínculo (o ML respondeu o "Ver produtos"
    // com outra forma da mesma listagem). O que estava suspenso passa a casar — sem esta
    // reavaliação, o painel só sairia do limbo no próximo evento de navegação.
    if (message.action === 'mlCouponContextChanged') {
      onCouponEvent(message.tabId, null, null);
      return;
    }
    // Documento novo carregado: abre a aba já com o cupom, sem esperar a extração.
    if (message.action === 'tabUpdated' && message.tab?.isSupported) {
      onCouponEvent(message.tab.id, message.tab.url, null);
    }
  });

  /**
   * O painel nasceu: esta aba é a listagem de produtos de algum cupom?
   *
   * ⚠️ A CONSULTA PRECISA INSISTIR. Quando o fluxo começa no web app, o painel é aberto
   * ANTES de a aba do cupom existir: `sidePanel.open()` roda síncrono (exigência do
   * gesto) e o `tabs.create` vem depois. Na primeira consulta a aba nova ou ainda não é
   * a ativa, ou tem `url` vazia (o destino vive em `pendingUrl`) — e aí
   * `containerState('')` devolve 'suspended'. A versão anterior desistia nesse ponto, e
   * era exatamente por isso que os produtos só apareciam quando o usuário trocava de aba
   * e voltava: a volta remontava este documento e refazia a consulta com a URL commitada.
   *
   * A insistência custa tempo SÓ quando a aba ativa tem vínculo de cupom pendente; em
   * qualquer outra página o laço sai na primeira volta.
   */
  async function bootCouponContext() {
    for (let tentativa = 0; tentativa < 12; tentativa++) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return;

      const context = await resolveCouponTabContext(activeTab.id, activeTab.url);
      if (context) {
        // A tela do cupom sobe JÁ, mesmo com a aba ainda fora da listagem: é a aba
        // "Cupons", o banner e o nome sugerido da lista. Antes o painel só montava isso
        // quando a URL casava, e enquanto não casasse ficava na aba Produtos, mudo — o
        // usuário via a extensão abrir "no lugar errado" sem nenhuma explicação.
        if (!(await ensureCouponProductsMode(context))) return;
        renderCouponSuspendedWarning(context);
        if (!context.suspenso) {
          await pullCouponProducts(context);
          return;
        }
        // Suspenso na abertura costuma ser a listagem ainda carregando: insiste.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Sem vínculo registrado não há o que esperar — o painel abre em qualquer página.
      const vinculo = await sendMessage({ action: 'getMlCouponTabContext', tabId: activeTab.id });
      if (!vinculo?.success || !vinculo.data) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  setupTabs();
  await checkAuth();

  try {
    await bootCouponContext();
  } catch (e) {
    console.warn('[SidePanel:Cupons] Falha ao checar contexto inicial:', e.message);
  }
});
