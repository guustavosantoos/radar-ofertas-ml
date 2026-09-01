import React, { useState, useEffect } from 'react';
import { LoginPage } from './components/LoginPage';
import { getStoredSession, signOutUser, supabase, isSupabaseConfigured } from './supabase';
import {
  LayoutDashboard,
  Settings,
  ShoppingBag,
  Tv,
  Users,
  Search,
  Zap,
  MessageSquare,
  Copy,
  CheckCircle2,
  Share2,
  DollarSign,
  X,
  TrendingUp,
  RefreshCw,
  Package,
  Star,
  ArrowRight,
  Filter,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Save,
  Eye,
  EyeOff,
  ExternalLink,
  LogOut,
  Edit3,
  HelpCircle,
  Send,
  Radio,
  Sparkles,
  Smartphone,
} from 'lucide-react';

interface Product {
  id: string;
  title: string;
  price: number;
  originalPrice?: number;
  discountPercentage?: number;
  freeShipping: boolean;
  thumbnail: string;
  url: string;
  affiliateUrl?: string;
}

interface PromotionalItem {
  deal: {
    product: Product;
    score: number;
    tier: string;
    reasons: string[];
  };
  messaging: {
    messageText: string;
    waMeUrl: string;
    templateId: string;
  };
}

interface MLCategory {
  id: string;
  name: string;
  parentId?: string | null;
}

type ActivePage = 'dashboard' | 'whatsapp' | 'custom-message' | 'settings';

const STORAGE_KEY = 'radar_ofertas_config';

interface MLConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  affiliateTag: string;
}

interface CustomTemplate {
  id: string;
  name: string;
  template: string;
}

function getSavedCustomTemplates(): CustomTemplate[] {
  try {
    const saved = localStorage.getItem('radar_custom_templates_list');
    if (saved) return JSON.parse(saved);
  } catch {}
  return [];
}

function formatCustomMessage(item: PromotionalItem, templateStr: string) {
  const product = item.deal.product;
  const score = item.deal.score ?? 50;
  const tier = item.deal.tier ?? 'BOA';

  const getEmoji = (tierStr: string) => {
    switch (tierStr) {
      case 'IMPERDÍVEL': return '🚨';
      case 'ÓTIMA': return '⚡';
      case 'BOA': return '🎯';
      default: return '🛍️';
    }
  };

  const formatCurrency = (val?: number) => {
    if (!val) return '';
    return `R$ ${val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const hasOriginalPrice = !!(product.originalPrice && product.originalPrice > product.price);
  const precoFormatted = formatCurrency(product.price);
  const precoAntigoFormatted = hasOriginalPrice ? formatCurrency(product.originalPrice!) : '';
  const descontoFormatted = product.discountPercentage ? `${product.discountPercentage}%` : '';
  const freteFormatted = product.freeShipping ? 'Frete Grátis 🚚' : 'Consulte o frete';
  const linkFormatted = product.affiliateUrl || product.url;

  let message = templateStr;
  message = message.replace(/\{produto\}/g, product.title);
  message = message.replace(/\{preco\}/g, precoFormatted);

  if (hasOriginalPrice) {
    message = message.replace(/\{precoAntigo\}/g, precoAntigoFormatted);
  } else {
    message = message.split('\n').filter(line => !line.includes('{precoAntigo}')).join('\n');
  }

  if (product.discountPercentage) {
    message = message.replace(/\{desconto\}/g, descontoFormatted);
  } else {
    message = message.replace(/\(\{desconto\} OFF\)/g, '')
                     .replace(/\(\{desconto\} de desconto\)/g, '')
                     .replace(/\{desconto\}/g, '');
  }

  message = message.replace(/\{frete\}/g, freteFormatted);
  message = message.replace(/\{link\}/g, linkFormatted);
  message = message.replace(/\{nivel\}/g, tier);
  message = message.replace(/\{emoji\}/g, getEmoji(tier));
  message = message.replace(/\{score\}/g, String(score));

  message = message.replace(/\n\n\n+/g, '\n\n').trim();
  const waMeUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;

  return { messageText: message, waMeUrl, templateId: 'custom' };
}

function loadConfig(): MLConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return { clientId: '', clientSecret: '', refreshToken: '', affiliateTag: '' };
}

function saveConfig(cfg: MLConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton skeleton-image" />
      <div className="skeleton-body">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-title-2" />
        <div className="skeleton skeleton-price" />
        <div className="skeleton skeleton-btn" />
        <div className="skeleton skeleton-btn" />
      </div>
    </div>
  );
}

// ─── Configurações ─────────────────────────────────────────
function SettingsPage() {
  const [cfg, setCfg] = useState(() => {
    const saved = localStorage.getItem('radar_ml_cfg');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return {
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      affiliateTag: '',
    };
  });

  const [isConnected, setIsConnected] = useState(() => {
    return !!(cfg.clientId && cfg.clientSecret);
  });
  const [showEditForm, setShowEditForm] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    localStorage.setItem('radar_ml_cfg', JSON.stringify(cfg));
    setIsConnected(true);
    setShowEditForm(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    setShowEditForm(true);
  };

  const field = (
    label: string,
    key: keyof typeof cfg,
    placeholder: string,
    type: string = 'text',
    toggleShow = false,
    show?: boolean,
    onToggle?: () => void
  ) => (
    <div className="settings-field">
      <label className="settings-label">{label}</label>
      <div className="settings-input-wrap">
        <input
          type={toggleShow && !show ? 'password' : 'text'}
          className="settings-input"
          placeholder={placeholder}
          value={cfg[key]}
          onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
        />
        {toggleShow && (
          <button className="settings-eye-btn" onClick={onToggle} type="button">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h2 className="settings-title">Configurações do Mercado Livre</h2>
        <p className="settings-sub">
          Gerencie a conexão da sua conta e credenciais de afiliado Mercado Livre.
        </p>
      </div>

      {isConnected && !showEditForm ? (
        <div className="settings-connected-card">
          <div className="connected-badge-row">
            <div className="connected-status-pill">
              <span className="dot-online-big" />
              <span>API MERCADO LIVRE CONECTADA</span>
            </div>
            <span className="connected-valid-tag">✓ Token Ativo & Válido</span>
          </div>

          <div className="connected-details-grid">
            <div className="connected-detail-box">
              <span className="detail-label">App ID (Client ID)</span>
              <span className="detail-value">{cfg.clientId || 'Configurado'}</span>
            </div>
            <div className="connected-detail-box">
              <span className="detail-label">Etiqueta de Afiliado</span>
              <span className="detail-value">{cfg.affiliateTag || 'Ativo'}</span>
            </div>
            <div className="connected-detail-box">
              <span className="detail-label">Status da Conexão</span>
              <span className="detail-value green">● Integrado com sucesso</span>
            </div>
          </div>

          <div className="connected-actions-row">
            <button className="btn-disconnect" onClick={handleDisconnect}>
              <LogOut size={16} /> Desconectar API
            </button>
            <button className="btn-edit-credentials" onClick={() => setShowEditForm(true)}>
              <Edit3 size={16} /> Alterar Credenciais
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-card">
          <div className="settings-section-label">
            <AlertCircle size={16} color="#ff5500" />
            Credenciais da API
          </div>

          {field('App ID (Client ID)', 'clientId', 'Ex: 108736459201928')}
          {field('Client Secret', 'clientSecret', 'Ex: Insira o Client Secret', 'password', true, showSecret, () => setShowSecret(s => !s))}
          {field('Refresh Token', 'refreshToken', 'Ex: TG-xxxxxxxxxxxxxxxx', 'password', true, showToken, () => setShowToken(s => !s))}

          <div className="settings-divider" />

          <div className="settings-section-label">
            <Zap size={16} color="#ff5500" />
            Tag de Afiliado
          </div>

          {field('Etiqueta de Afiliado', 'affiliateTag', 'Ex: sua_tag_afiliado')}

          <div className="settings-hint">
            💡 Sua tag é o nome exibido em "Etiqueta em uso" no painel de Afiliados do Mercado Livre.
            Ela será injetada em todos os links gerados automaticamente.
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
            <button className="btn-save" onClick={handleSave} style={{ flex: 1 }}>
              {saved ? <><CheckCircle2 size={16} /> Salvo & Conectado!</> : <><Save size={16} /> Salvar e Conectar API</>}
            </button>
            {isConnected && (
              <button
                className="btn-edit-credentials"
                onClick={() => setShowEditForm(false)}
                type="button"
              >
                Cancelar
              </button>
            )}
          </div>
        </div>
      )}

      <div className="steps-guide-card" style={{ marginTop: 24 }}>
        <div className="steps-guide-header">
          <HelpCircle size={24} color="#ff5500" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <h3 className="steps-guide-title">Passo a Passo: Como vincular sua conta Mercado Livre</h3>
            <p className="steps-guide-sub">Siga os 3 passos simples abaixo para obter seu Client ID e Client Secret:</p>
          </div>
        </div>

        <div className="steps-list">
          <div className="step-item">
            <div className="step-number">1</div>
            <div className="step-content">
              <h4 className="step-title">Acesse o Portal Mercado Livre Developers</h4>
              <p className="step-desc">
                Entre em <a href="https://developers.mercadolivre.com.br" target="_blank" rel="noreferrer">developers.mercadolivre.com.br</a> e faça login na sua conta do Mercado Livre.
              </p>
            </div>
          </div>

          <div className="step-item">
            <div className="step-number">2</div>
            <div className="step-content">
              <h4 className="step-title">Crie uma Aplicação e Copie o Client ID & Client Secret</h4>
              <p className="step-desc">
                Vá em <strong>Meus Aplicativos → Criar nova aplicação</strong>. Preencha o nome da aplicação e em <i>Redirect URI</i> coloque <code>https://oauth.pstmn.io/v1/callback</code>.
                Após salvar, o painel exibirá o seu <strong>App ID (Client ID)</strong> e o <strong>Client Secret</strong>.
              </p>
            </div>
          </div>

          <div className="step-item">
            <div className="step-number">3</div>
            <div className="step-content">
              <h4 className="step-title">Vincule na Ferramenta com sua Tag de Afiliado</h4>
              <p className="step-desc">
                Informe o seu <strong>App ID</strong> e <strong>Client Secret</strong>, adicione a sua <strong>Etiqueta de Afiliado</strong> (disponível no <a href="https://afiliados.mercadolivre.com.br" target="_blank" rel="noreferrer">Painel de Afiliados ML</a>) e clique em <strong>Salvar e Conectar API</strong>. Pronto!
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────
function Dashboard({ selectedTemplate, setSelectedTemplate }: { selectedTemplate: string; setSelectedTemplate: (t: string) => void }) {
  const [activeTab, setActiveTab] = useState('all');
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>(getSavedCustomTemplates);
  const [searchTerm, setSearchTerm] = useState('');
  const [items, setItems] = useState<PromotionalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<PromotionalItem | null>(null);
  const [matchedCategory, setMatchedCategory] = useState<MLCategory | null>(null);

  // Categorias do Mercado Livre
  const [categories, setCategories] = useState<MLCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categorySearch, setCategorySearch] = useState('');
  const [showCategoryPanel, setShowCategoryPanel] = useState(true);

  // Auto-Refresh em Tempo Real
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [countdown, setCountdown] = useState(120); // 2 minutos
  const [lastUpdateText, setLastUpdateText] = useState<string>('');

  const normalizeStr = (str: string) =>
    str ? str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';

  // Sincroniza templates customizados dinamicamente
  useEffect(() => {
    const handleUpdate = () => setCustomTemplates(getSavedCustomTemplates());
    window.addEventListener('radar_templates_updated', handleUpdate);
    return () => window.removeEventListener('radar_templates_updated', handleUpdate);
  }, []);

  // Carrega a lista de todas as categorias oficiais do Mercado Livre
  useEffect(() => {
    fetch('/api/v1/marketplace/mercadolivre/categories')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data) {
          // Deduplica categorias por id para evitar warning de keys duplicadas
          const seen = new Set<string>();
          const unique = (data.data as MLCategory[]).filter(c => {
            if (seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
          });
          setCategories(unique);
        }
      })
      .catch(err => console.error('Erro ao carregar categorias:', err));
  }, []);

  // fetchDeals recebe categoryId e template explicitamente
  const fetchDeals = async (opts: {
    tab: string;
    template: string;
    categoryId?: string | null;
  }) => {
    setLoading(true);
    try {
      const { tab, template, categoryId } = opts;
      const isCustom = customTemplates.some(t => t.id === template);
      const apiTemplate = isCustom ? 'achadinhos' : template;

      let url = `/api/v1/marketplace/mercadolivre/promotional-messages?template=${apiTemplate}&minScore=0`;

      // Categoria: prioriza a selecionada no painel; depois aba de atalho
      const catToUse = categoryId || (tab !== 'all' ? tab : undefined);
      if (catToUse) {
        url += `&category=${catToUse}`;
      }

      const res = await fetch(url);
      const data = await res.json();
      if (data.success && data.data) {
        // Deduplica por p.id para eliminar a warning de keys duplicadas
        const seen = new Set<string>();
        let unique = (data.data as PromotionalItem[]).filter((item, idx) => {
          const key = item.deal.product.id || String(idx);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Se for um template customizado, aplica a formatação no cliente
        if (isCustom) {
          const targetCustom = customTemplates.find(t => t.id === template);
          if (targetCustom) {
            unique = unique.map(item => ({
              ...item,
              messaging: formatCustomMessage(item, targetCustom.template)
            }));
          }
        }

        setItems(unique);
        const now = new Date();
        setLastUpdateText(now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      }
    } catch (err) {
      console.error('Erro ao buscar ofertas:', err);
    } finally {
      setLoading(false);
    }
  };

  // Re-busca sempre que tab, template ou categoria selecionada mudar
  useEffect(() => {
    fetchDeals({ tab: activeTab, template: selectedTemplate, categoryId: selectedCategoryId });
    setCountdown(120);
  }, [activeTab, selectedTemplate, selectedCategoryId]);

  // Contagem regressiva para auto-atualizar o feed
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          fetchDeals({ tab: activeTab, template: selectedTemplate, categoryId: selectedCategoryId });
          return 120;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, activeTab, selectedTemplate, selectedCategoryId]);

  const formatSeconds = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const handleSearchChange = (val: string) => {
    setSearchTerm(val);
    // Limpa o resultado de busca anterior quando o campo é editado
    if (matchedCategory) setMatchedCategory(null);
  };

  // Busca por palavra-chave ao pressionar Enter: chama /search que mapeia para categoria ML
  const handleSearchKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const term = searchTerm.trim();
    if (!term) {
      // Limpa a busca e volta ao estado normal
      setMatchedCategory(null);
      setSelectedCategoryId(null);
      fetchDeals({ tab: activeTab, template: selectedTemplate, categoryId: null });
      return;
    }
    setLoading(true);
    try {
      const isCustom = customTemplates.some(t => t.id === selectedTemplate);
      const apiTemplate = isCustom ? 'achadinhos' : selectedTemplate;

      const res = await fetch(
        `/api/v1/marketplace/mercadolivre/search?q=${encodeURIComponent(term)}&template=${apiTemplate}`
      );
      const data = await res.json();
      if (data.success) {
        setMatchedCategory(data.matchedCategory || null);
        // Deduplica por id
        const seen = new Set<string>();
        let unique = (data.data as PromotionalItem[]).filter((item, idx) => {
          const key = item.deal.product.id || String(idx);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        if (isCustom) {
          const targetCustom = customTemplates.find(t => t.id === selectedTemplate);
          if (targetCustom) {
            unique = unique.map(item => ({
              ...item,
              messaging: formatCustomMessage(item, targetCustom.template)
            }));
          }
        }

        setItems(unique);
        // Sincroniza painel de categorias com a categoria encontrada
        if (data.matchedCategory) {
          setSelectedCategoryId(null); // não seleciona no painel para não re-disparar useEffect
        }
      }
    } catch (err) {
      console.error('Erro na busca por keyword:', err);
    } finally {
      setLoading(false);
    }
  };

  const [expandedParentId, setExpandedParentId] = useState<string | null>(null);

  const toggleSelectCategory = (catId: string) => {
    setMatchedCategory(null); // limpa resultado de busca ao selecionar categoria manual
    setSearchTerm('');
    if (selectedCategoryId === catId) {
      setSelectedCategoryId(null);
    } else {
      setSelectedCategoryId(catId);
      // Se for categoria principal, expande automaticamente para revelar subcategorias
      const catObj = categories.find(c => c.id === catId);
      if (catObj && !catObj.parentId) {
        setExpandedParentId(catId);
      } else if (catObj && catObj.parentId) {
        setExpandedParentId(catObj.parentId);
      }
    }
  };

  const toggleExpandParent = (parentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedParentId(prev => (prev === parentId ? null : parentId));
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);
  };

  const tierClass = (tier: string) =>
    tier.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // items já chegam filtrados (busca server-side)
  const filteredItems = items;

  // Filtra categorias visíveis no painel de categorias
  const isSearchActive = !!categorySearch.trim();
  const searchNorm = normalizeStr(categorySearch.trim());

  const topLevelCategories = categories.filter(c => !c.parentId);
  const searchFilteredCategories = categories.filter(c =>
    normalizeStr(c.name).includes(searchNorm)
  );

  return (
    <>
      {/* Saudação */}
      <div className="header-greeting" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="greeting-title">Boa tarde, Gustavo 👋</h1>
          <p className="greeting-sub">Acompanhe as melhores ofertas do Mercado Livre em tempo real.</p>
        </div>
        {lastUpdateText && (
          <div style={{ fontSize: '0.8rem', color: '#0284c7', fontWeight: 600, background: '#f0f9ff', padding: '6px 14px', borderRadius: 20, border: '1px solid #bae6fd', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#0284c7', display: 'inline-block' }}></span>
            Última atualização: <strong>{lastUpdateText}</strong>
          </div>
        )}
      </div>

      {/* Métricas */}
      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">Ofertas Encontradas</span>
          <span className="metric-val">{loading ? '…' : filteredItems.length}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Com Frete Grátis</span>
          <span className="metric-val">
            {loading ? '…' : filteredItems.filter(i => i.deal.product.freeShipping).length}
          </span>
        </div>
        <div className="metric-card highlight">
          <span className="metric-label">Maior Desconto</span>
          <span className="metric-val">
            {loading ? '…' : (() => {
              const max = Math.max(...filteredItems.map(i => i.deal.product.discountPercentage ?? 0));
              return max > 0 ? `-${max}%` : '—';
            })()}
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Tag de Afiliado</span>
          <span className="metric-val" style={{ fontSize: '1rem' }}>
            {(() => {
              try {
                const s = localStorage.getItem('radar_ml_cfg');
                return s ? JSON.parse(s)?.affiliateTag || 'Ativo' : 'Ativo';
              } catch { return 'Ativo'; }
            })()}
          </span>
        </div>
      </div>

      {/* ─── Painel de Categorias Mercado Livre (Estilo Achadinho Pro) ─── */}
      <div className="category-selector-card">
        <div className="category-selector-header">
          <div className="category-selector-title">
            <Filter size={18} color="#ff5500" />
            <span>Categorias para Busca Mercado Livre ({selectedCategoryId ? '1 selecionada' : '0 selecionadas'})</span>
          </div>

          <button 
            onClick={() => setShowCategoryPanel(!showCategoryPanel)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700, fontSize: '0.82rem', color: '#64748b' }}
          >
            {showCategoryPanel ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            {showCategoryPanel ? 'Ocultar' : 'Expandir'}
          </button>
        </div>

        {showCategoryPanel && (
          <>
            <div className="category-selector-search">
              <Search size={16} color="#94a3b8" />
              <input
                type="text"
                placeholder="Buscar categorias do Mercado Livre por nome (ex: Celulares, Informática, Bebês)..."
                value={categorySearch}
                onChange={(e) => setCategorySearch(e.target.value)}
              />
            </div>

            <div className="category-meta-bar">
              <span>
                {isSearchActive
                  ? `${searchFilteredCategories.length} resultado(s) para "${categorySearch}"`
                  : `${topLevelCategories.length} categorias principais (clique para expandir subcategorias)`}
              </span>
              {selectedCategoryId && (
                <button 
                  className="clear-selection-btn"
                  onClick={() => setSelectedCategoryId(null)}
                >
                  Limpar seleção
                </button>
              )}
            </div>

            <div className="category-checklist-box">
              {isSearchActive ? (
                searchFilteredCategories.length === 0 ? (
                  <div style={{ padding: '16px', fontStyle: 'italic', color: '#94a3b8', fontSize: '0.85rem' }}>
                    Nenhuma categoria encontrada com o nome "{categorySearch}"
                  </div>
                ) : (
                  searchFilteredCategories.map(cat => {
                    const isSelected = selectedCategoryId === cat.id;
                    const isSubcat = !!cat.parentId;
                    return (
                      <div
                        key={cat.id}
                        className={`category-check-item ${isSelected ? 'selected' : ''} ${isSubcat ? 'subcat' : ''}`}
                        onClick={() => toggleSelectCategory(cat.id)}
                        style={isSubcat ? { paddingLeft: 28 } : undefined}
                      >
                        <input
                          type="checkbox"
                          className="category-checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                        />
                        <span style={{ fontSize: isSubcat ? '0.8rem' : '0.85rem', color: isSubcat ? '#64748b' : undefined }}>
                          {isSubcat ? '↳ ' : ''}{cat.name}
                        </span>
                      </div>
                    );
                  })
                )
              ) : (
                topLevelCategories.map(parentCat => {
                  const isParentSelected = selectedCategoryId === parentCat.id;
                  const subcats = categories.filter(c => c.parentId === parentCat.id);
                  const isSelectedInSub = subcats.some(s => s.id === selectedCategoryId);
                  const isExpanded = expandedParentId === parentCat.id || isParentSelected || isSelectedInSub;

                  return (
                    <React.Fragment key={parentCat.id}>
                      <div
                        className={`category-check-item ${isParentSelected ? 'selected' : ''}`}
                        onClick={() => toggleSelectCategory(parentCat.id)}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            className="category-checkbox"
                            checked={isParentSelected}
                            onChange={() => {}}
                          />
                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                            {parentCat.name}
                          </span>
                        </div>

                        {subcats.length > 0 && (
                          <button
                            onClick={(e) => toggleExpandParent(parentCat.id, e)}
                            style={{
                              background: '#f1f5f9', border: 'none', borderRadius: 6,
                              padding: '2px 8px', fontSize: '0.75rem', fontWeight: 600,
                              color: isExpanded ? '#ff5500' : '#64748b', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: 4,
                            }}
                          >
                            <span>{subcats.length} sub</span>
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        )}
                      </div>

                      {/* Subcategorias aninhadas expandidas */}
                      {isExpanded && subcats.map(subCat => {
                        const isSubSelected = selectedCategoryId === subCat.id;
                        return (
                          <div
                            key={subCat.id}
                            className={`category-check-item subcat ${isSubSelected ? 'selected' : ''}`}
                            onClick={() => toggleSelectCategory(subCat.id)}
                            style={{ paddingLeft: 32, background: isSubSelected ? '#fff4ed' : '#fafafa' }}
                          >
                            <input
                              type="checkbox"
                              className="category-checkbox"
                              checked={isSubSelected}
                              onChange={() => {}}
                            />
                            <span style={{ fontSize: '0.8rem', color: isSubSelected ? '#ff5500' : '#475569' }}>
                              ↳ {subCat.name}
                            </span>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })
              )}
            </div>

            <div className="category-hint-text">
              💡 Selecione uma categoria para filtrar as ofertas correspondentes do Mercado Livre em tempo real.
            </div>
          </>
        )}
      </div>

      {/* Barra de Filtros e Busca por Produto */}
      <div className="filter-bar">
        <div className="search-box">
          <Search size={18} color="#64748b" />
          <input
            type="text"
            className="search-input"
            placeholder="Buscar produto por nome (ex: whey, notebook, fone)..."
            value={searchTerm}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
        </div>

        <div className="category-tabs">
          {[
            { key: 'all', label: '🔥 Todas' },
            { key: 'best_sellers', label: '🏆 Mais Vendidos' },
            { key: 'MLB1051', label: '📱 Celulares' },
            { key: 'MLB1648', label: '💻 Informática' },
            { key: 'MLB1000', label: '📺 Eletrônicos' },
            { key: 'MLB1430', label: '👗 Moda' },
          ].map(tab => (
            <button
              key={tab.key}
              className={`tab-btn ${activeTab === tab.key && !selectedCategoryId ? 'active' : ''}`}
              onClick={() => {
                setSelectedCategoryId(null);
                setActiveTab(tab.key);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#64748b', whiteSpace: 'nowrap' }}>
            Template:
          </label>
          <select
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
            style={{
              padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1',
              fontWeight: 700, fontSize: '0.82rem', backgroundColor: 'white',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <option value="achadinhos">📲 Achadinhos Meli</option>
            <option value="default">📝 Padrão Completo</option>
            <option value="flash">⚡ Alerta Flash</option>
            {customTemplates.map(t => (
              <option key={t.id} value={t.id}>✨ {t.name}</option>
            ))}
          </select>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? 'Clique para pausar auto-atualização' : 'Clique para ativar auto-atualização'}
            style={{
              padding: '8px 12px', borderRadius: 8,
              border: autoRefresh ? '1px solid #bbf7d0' : '1px solid #cbd5e1',
              background: autoRefresh ? '#f0fdf4' : 'white',
              color: autoRefresh ? '#15803d' : '#64748b',
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              gap: 6, fontWeight: 700, fontSize: '0.82rem', fontFamily: 'inherit',
            }}
          >
            <span>{autoRefresh ? '🟢 Live Feed' : '⏸️ Pausado'}</span>
            {autoRefresh && <span style={{ fontSize: '0.78rem', color: '#16a34a' }}>({formatSeconds(countdown)})</span>}
          </button>

          <button
            onClick={() => fetchDeals({ tab: activeTab, template: selectedTemplate, categoryId: selectedCategoryId })}
            style={{
              padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0',
              background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center',
              gap: 6, fontWeight: 700, fontSize: '0.82rem', color: '#64748b', fontFamily: 'inherit',
            }}
          >
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      </div>

      {/* Grid de Produtos */}

      {/* Banner de categoria mapeada pela busca */}
      {matchedCategory && !loading && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
          background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
          border: '1px solid #bae6fd', borderRadius: 12, marginBottom: 12,
          fontSize: '0.85rem', color: '#0369a1', fontWeight: 600,
        }}>
          <span>🎯</span>
          <span>
            Exibindo ofertas de <strong>"{matchedCategory.name}"</strong>
            {' '}— categoria mais próxima para "{searchTerm}"
          </span>
          <button
            onClick={() => {
              setMatchedCategory(null);
              setSearchTerm('');
              fetchDeals({ tab: activeTab, template: selectedTemplate, categoryId: null });
            }}
            style={{
              marginLeft: 'auto', padding: '4px 10px', borderRadius: 8,
              border: '1px solid #7dd3fc', background: 'white', cursor: 'pointer',
              fontSize: '0.8rem', color: '#0369a1', fontWeight: 700,
            }}
          >
            ✕ Limpar busca
          </button>
        </div>
      )}

      {loading ? (
        <div className="products-grid">
          {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">🔍</span>
          <span className="empty-state-title">Nenhum produto encontrado</span>
          <span className="empty-state-desc">
            {searchTerm
              ? `Não encontramos uma categoria correspondente a "${searchTerm}". Tente termos como: notebook, celular, carro, geladeira, roupas...`
              : 'Clique em "Atualizar" ou selecione uma categoria no painel à esquerda.'}
          </span>
        </div>
      ) : (
        <div className="products-grid">
          {filteredItems.map((item, idx) => {
            const p = item.deal.product;
            const tc = tierClass(item.deal.tier);
            return (
              <div className="product-card" key={p.id || idx}>
                <div className="card-image-box">
                  <span className={`tier-badge ${tc}`}>
                    {item.deal.tier} · {item.deal.score} pts
                  </span>
                  {(p.discountPercentage ?? 0) > 0 && (
                    <span className="discount-badge">-{p.discountPercentage}%</span>
                  )}
                  <img src={p.thumbnail} alt={p.title} className="card-img" />
                </div>

                <div className="card-body">
                  <h3 className="card-title">{p.title}</h3>

                  <div className="card-price-box">
                    {p.originalPrice && (
                      <div className="old-price">
                        De R$ {p.originalPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </div>
                    )}
                    <div className="current-price">
                      R$ {p.price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </div>
                  </div>

                  <div className="card-meta-pills">
                    {p.freeShipping && <span className="meta-pill free-shipping">🚚 Frete Grátis</span>}
                    <span className="meta-pill">🏷️ {item.deal.tier}</span>
                  </div>

                  {/* Link de afiliado limpo nativo */}
                  {p.affiliateUrl && (
                    <div className="affiliate-link-box">
                      <a href={p.affiliateUrl} target="_blank" rel="noreferrer" className="affiliate-link-text">
                        {p.affiliateUrl.replace('https://', '').slice(0, 48)}…
                      </a>
                      <a href={p.affiliateUrl} target="_blank" rel="noreferrer" className="affiliate-open-btn">
                        <ExternalLink size={13} />
                      </a>
                    </div>
                  )}

                  <div className="card-actions">
                    <button
                      className="btn-action-primary"
                      onClick={() => handleCopy(p.id, item.messaging.messageText)}
                    >
                      {copiedId === p.id
                        ? <><CheckCircle2 size={15} /> Copiado!</>
                        : <><Copy size={15} /> Copiar Mensagem</>}
                    </button>

                    <a
                      href={item.messaging.waMeUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-action-secondary"
                      style={{ textDecoration: 'none' }}
                    >
                      <Share2 size={15} /> Enviar no WhatsApp
                    </a>

                    <button
                      className="btn-preview"
                      onClick={() => setPreviewItem(item)}
                    >
                      👁️ Ver Preview
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Live Preview */}
      {previewItem && (
        <div className="modal-overlay" onClick={() => setPreviewItem(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">📲 Preview — WhatsApp</span>
              <button onClick={() => setPreviewItem(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={20} color="#64748b" />
              </button>
            </div>

            <div className="modal-body">
              <div className="whatsapp-chat-preview">
                <div style={{ marginBottom: 6, fontSize: '0.7rem', color: '#8696a0', fontWeight: 700 }}>
                  🤖 Radar Achadinhos
                </div>
                <div className="whatsapp-bubble">
                  {previewItem.messaging.messageText}
                </div>
                <div style={{ textAlign: 'right', marginTop: 6, fontSize: '0.68rem', color: '#8696a0' }}>
                  ✓✓ {new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  className="btn-action-primary"
                  style={{ flex: 1 }}
                  onClick={() => handleCopy('modal', previewItem.messaging.messageText)}
                >
                  {copiedId === 'modal'
                    ? <><CheckCircle2 size={15} /> Copiado!</>
                    : <><Copy size={15} /> Copiar Mensagem</>}
                </button>
                <a
                  href={previewItem.messaging.waMeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-action-secondary"
                  style={{ textDecoration: 'none', flex: 1 }}
                >
                  <Share2 size={15} /> Enviar
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── WhatsApp & Grupos ───────────────────────────────────
function WhatsAppPage() {
  return (
    <div className="whatsapp-page-container">
      <div className="settings-header">
        <h2 className="settings-title">Conexão WhatsApp & Automções</h2>
        <p className="settings-sub">
          Gerenciamento e automação de disparos em grupos do WhatsApp.
        </p>
      </div>

      {/* Card EM BREVE Desabilitado */}
      <div
        className="custom-editor-card"
        style={{
          background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
          borderRadius: 16,
          border: '1px stroke #e2e8f0',
          padding: 32,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Share2 size={24} color="#64748b" />
            </div>
            <div>
              <h3 style={{ fontWeight: 800, fontSize: '1.15rem', color: '#0f172a', margin: 0 }}>
                Conexão Automática com WhatsApp
              </h3>
              <p style={{ fontSize: '0.86rem', color: '#64748b', margin: 0 }}>
                Instâncias e disparos automáticos em lote
              </p>
            </div>
          </div>

          <span style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', fontWeight: 800, padding: '6px 14px', borderRadius: 20, fontSize: '0.8rem' }}>
            🚀 EM BREVE — LANÇAMENTO
          </span>
        </div>

        <div style={{ background: 'white', border: '1px solid #cbd5e1', borderRadius: 16, padding: 28, opacity: 0.65, pointerEvents: 'none', filter: 'grayscale(30%)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>📱</div>
            <h4 style={{ fontWeight: 800, fontSize: '1.1rem', color: '#0f172a', marginBottom: 8 }}>
              Integração de Disparos Automáticos em Breve
            </h4>
            <p style={{ fontSize: '0.88rem', color: '#64748b', maxWidth: 460, margin: '0 0 20px 0', lineHeight: 1.5 }}>
              A conexão por QR Code e disparos automáticos em lote nos grupos estará disponível em breve no lançamento oficial.
            </p>

            <button
              disabled
              style={{
                background: '#94a3b8',
                color: 'white',
                border: 'none',
                padding: '12px 24px',
                borderRadius: 10,
                fontWeight: 800,
                fontSize: '0.9rem',
                cursor: 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              🔒 Conexão Indisponível (Em Breve)
            </button>
          </div>
        </div>
      </div>

      {/* Dica de Envio Direto via Dashboard */}
      <div className="custom-editor-card" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: 24 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{ fontSize: '1.5rem' }}>💡</div>
          <div>
            <h4 style={{ fontWeight: 800, fontSize: '1rem', color: '#166534', margin: '0 0 6px 0' }}>
              Como enviar ofertas pelo WhatsApp agora mesmo?
            </h4>
            <p style={{ fontSize: '0.86rem', color: '#15803d', margin: 0, lineHeight: 1.5 }}>
              No <strong>Dashboard</strong>, basta clicar no botão verde <strong>`📲 Enviar no WhatsApp`</strong> presente em qualquer card de oferta. O sistema abrirá o seu WhatsApp (Web ou App no celular) com a mensagem formatada e seu link de afiliado pronto para enviar para qualquer grupo ou contato!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Mensagem Personalizada ──────────────────────────────
function CustomMessagePage({ onSelectTemplate }: { onSelectTemplate?: (id: string) => void }) {
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>(getSavedCustomTemplates);
  const [templateName, setTemplateName] = useState('✨ Meu Template Personalizado');
  const [templateText, setTemplateText] = useState(
    `🔥 *{emoji} OPORTUNIDADE EXCLUSIVA!*\n\n*{produto}*\n\nDe ~{precoAntigo}~\nPor apenas *{preco}* 💵 ({desconto} OFF)\n💳 {parcelamento}\n🚚 {frete}\n\n🛒 *Compre direto no link oficial:* \n{link}`
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const insertTag = (tag: string) => {
    setTemplateText(prev => prev + ' ' + tag);
  };

  const handleSave = () => {
    if (!templateName.trim()) return alert('Informe um nome para a mensagem personalizada.');
    const id = editingId || `custom-${Date.now()}`;
    const newTpl: CustomTemplate = { id, name: templateName, template: templateText };

    const current = getSavedCustomTemplates();
    const idx = current.findIndex(t => t.id === id);
    if (idx >= 0) current[idx] = newTpl;
    else current.push(newTpl);

    localStorage.setItem('radar_custom_templates_list', JSON.stringify(current));
    window.dispatchEvent(new Event('radar_templates_updated'));

    fetch('/api/v1/whatsapp/custom-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: templateName, templateText }),
    }).catch(e => console.error(e));

    setCustomTemplates(current);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    setEditingId(null);
    setTemplateName('✨ Novo Template Customizado');
  };

  const handleEdit = (tpl: CustomTemplate) => {
    setEditingId(tpl.id);
    setTemplateName(tpl.name);
    setTemplateText(tpl.template);
  };

  const handleDelete = (id: string) => {
    const current = getSavedCustomTemplates().filter(t => t.id !== id);
    localStorage.setItem('radar_custom_templates_list', JSON.stringify(current));
    window.dispatchEvent(new Event('radar_templates_updated'));
    setCustomTemplates(current);

    fetch(`/api/v1/whatsapp/custom-templates/${id}`, { method: 'DELETE' }).catch(e => console.error(e));
  };

  // Preview com dados de exemplo
  const samplePreview = templateText
    .replace(/\{produto\}/g, 'Smart TV 55 4K UHD Samsung Wi-Fi')
    .replace(/\{preco\}/g, 'R$ 2.199,00')
    .replace(/\{precoAntigo\}/g, 'R$ 3.899,00')
    .replace(/\{desconto\}/g, '43%')
    .replace(/\{parcelamento\}/g, '10x de R$ 219,90')
    .replace(/\{frete\}/g, 'Frete Grátis 🚚')
    .replace(/\{link\}/g, 'https://mercadolivre.com.br/sec/exemplo')
    .replace(/\{emoji\}/g, '⚡')
    .replace(/\{nivel\}/g, 'IMPERDÍVEL');

  return (
    <div className="whatsapp-page-container">
      <div className="settings-header">
        <h2 className="settings-title">Mensagem Personalizada WhatsApp</h2>
        <p className="settings-sub">
          Crie e salve seus próprios formatos de mensagem. Todos os modelos salvos ficam disponíveis automaticamente no Dashboard!
        </p>
      </div>

      <div className="custom-editor-card">
        <div className="settings-field">
          <label className="settings-label">Nome do Template Customizado</label>
          <input
            type="text"
            className="settings-input"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
          />
        </div>

        <div className="settings-field">
          <label className="settings-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Texto da Mensagem (Clique nas tags abaixo para inserir no texto)</span>
          </label>

          {/* Chips de Inserção de Tags */}
          <div className="tags-bar">
            <button className="tag-chip-btn" onClick={() => insertTag('{produto}')}>+ {`{produto}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{preco}')}>+ {`{preco}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{precoAntigo}')}>+ {`{precoAntigo}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{desconto}')}>+ {`{desconto}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{link}')}>+ {`{link}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{frete}')}>+ {`{frete}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{parcelamento}')}>+ {`{parcelamento}`}</button>
            <button className="tag-chip-btn" onClick={() => insertTag('{emoji}')}>+ {`{emoji}`}</button>
          </div>

          <textarea
            className="custom-textarea"
            style={{ minHeight: 180 }}
            value={templateText}
            onChange={(e) => setTemplateText(e.target.value)}
          />
        </div>

        <button className="btn-save" onClick={handleSave} style={{ marginTop: 10 }}>
          {saved ? <><CheckCircle2 size={16} /> Salvo & Adicionado aos Templates!</> : <><Save size={16} /> Salvar e Adicionar aos Templates</>}
        </button>
      </div>

      {/* Lista de Templates Salvos */}
      {customTemplates.length > 0 && (
        <div className="custom-editor-card">
          <h3 style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f172a', marginBottom: 14 }}>
            📋 Meus Templates Salvos ({customTemplates.length})
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {customTemplates.map(tpl => (
              <div
                key={tpl.id}
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 12,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#0f172a' }}>
                    {tpl.name}
                  </span>

                  <div style={{ display: 'flex', gap: 8 }}>
                    {onSelectTemplate && (
                      <button
                        onClick={() => onSelectTemplate(tpl.id)}
                        style={{ background: '#ff5500', color: 'white', border: 'none', padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}
                      >
                        🚀 Usar no Dashboard
                      </button>
                    )}
                    <button
                      onClick={() => handleEdit(tpl)}
                      style={{ background: 'white', border: '1px solid #cbd5e1', padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}
                    >
                      ✏️ Editar
                    </button>
                    <button
                      onClick={() => handleDelete(tpl.id)}
                      style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}
                    >
                      🗑️ Excluir
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: '0.82rem', color: '#475569', whiteSpace: 'pre-wrap', background: 'white', padding: 12, borderRadius: 8, border: '1px solid #f1f5f9' }}>
                  {tpl.template}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live Preview WhatsApp */}
      <div className="custom-editor-card">
        <h3 style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f172a', marginBottom: 12 }}>
          📱 Live Preview — WhatsApp
        </h3>

        <div className="whatsapp-chat-preview">
          <div style={{ marginBottom: 6, fontSize: '0.7rem', color: '#8696a0', fontWeight: 700 }}>
            🤖 Achadinho Pro Bot
          </div>
          <div className="whatsapp-bubble">
            {samplePreview}
          </div>
          <div style={{ textAlign: 'right', marginTop: 6, fontSize: '0.68rem', color: '#8696a0' }}>
            ✓✓ {new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App Root ────────────────────────────────────────────
export function App() {
  const [currentUser, setCurrentUser] = useState<any>(() => {
    const saved = getStoredSession();
    return saved?.user || null;
  });
  const [sessionLoading, setSessionLoading] = useState(true);
  const [page, setPage] = useState<ActivePage>('dashboard');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('achadinhos');

  useEffect(() => {
    if (isSupabaseConfigured && supabase) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) {
          setCurrentUser(session.user);
        }
        setSessionLoading(false);
      }).catch(() => setSessionLoading(false));

      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        setCurrentUser(session?.user || null);
      });

      return () => {
        subscription.unsubscribe();
      };
    } else {
      setSessionLoading(false);
    }
  }, []);

  const handleLogout = async () => {
    await signOutUser();
    setCurrentUser(null);
  };

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplate(id);
    setPage('dashboard');
  };

  if (sessionLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b0f19', color: '#ea580c' }}>
        <div style={{ textAlign: 'center' }}>
          <Zap size={40} color="#ea580c" style={{ animation: 'spin 2s linear infinite' }} />
          <div style={{ marginTop: 14, fontWeight: 700, fontSize: '0.95rem', color: '#94a3b8' }}>Carregando Radar ML...</div>
        </div>
      </div>
    );
  }

  // Se não autenticado, renderiza a Landing Page de Login do Figma
  if (!currentUser) {
    return <LoginPage onSuccess={(user) => setCurrentUser(user)} />;
  }

  const displayName = currentUser.user_metadata?.full_name || currentUser.email?.split('@')[0] || 'Usuário';
  const displayEmail = currentUser.email || 'usuario@radarofertas.com';
  const avatarInitials = displayName.substring(0, 2).toUpperCase();

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon-box">
            <Zap size={22} fill="white" />
          </div>
          <div className="logo-text">
            <span className="logo-title">Radar</span>
            <span className="logo-subtitle">Ofertas ML</span>
          </div>
        </div>

        <nav className="sidebar-menu">
          <button
            className={`menu-item ${page === 'dashboard' ? 'active' : ''}`}
            onClick={() => setPage('dashboard')}
          >
            <LayoutDashboard size={18} /> <span>Dashboard</span>
          </button>

          <button
            className={`menu-item ${page === 'whatsapp' ? 'active' : ''}`}
            onClick={() => setPage('whatsapp')}
          >
            <Share2 size={18} /> <span>WhatsApp & Grupos</span>
          </button>

          <button
            className={`menu-item ${page === 'custom-message' ? 'active' : ''}`}
            onClick={() => setPage('custom-message')}
          >
            <MessageSquare size={18} /> <span>Mensagem Custom</span>
          </button>

          <button
            className={`menu-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => setPage('settings')}
          >
            <Settings size={18} /> <span>Configurações</span>
          </button>
        </nav>

        <div className="sidebar-bottom-actions">
          <div className="user-profile-box">
            <div className="user-avatar">{avatarInitials}</div>
            <div className="user-info">
              <span className="user-name">{displayName}</span>
              <span className="user-plan" title={displayEmail}>{displayEmail}</span>
            </div>
            <button
              className="btn-logout"
              onClick={handleLogout}
              title="Encerrar Sessão"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <div className="top-bar">
          <div className="breadcrumb">
            RADAR OFERTAS ML / {
              page === 'dashboard' ? 'DASHBOARD' :
              page === 'whatsapp' ? 'WHATSAPP & GRUPOS' :
              page === 'custom-message' ? 'MENSAGEM PERSONALIZADA' :
              'CONFIGURAÇÕES'
            }
          </div>
          <div className="status-badge-online">
            <span className="dot-online" />
            API ONLINE
          </div>
        </div>

        {page === 'dashboard' && (
          <Dashboard
            selectedTemplate={selectedTemplate}
            setSelectedTemplate={setSelectedTemplate}
          />
        )}
        {page === 'whatsapp' && <WhatsAppPage />}
        {page === 'custom-message' && (
          <CustomMessagePage onSelectTemplate={handleSelectTemplate} />
        )}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
