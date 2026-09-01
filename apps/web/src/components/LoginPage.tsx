import React, { useState, useEffect } from 'react';
import { Zap, Eye, EyeOff, Check, AlertCircle, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { signInWithEmail, signUpWithEmail } from '../supabase';

interface LoginPageProps {
  onSuccess: (user: any) => void;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Carrossel de Depoimentos Automático
  const testimonials = [
    {
      quote: "Economizei mais de R$ 2.400 no primeiro mês garimpando ofertas pelo Radar ML. Os achadinhos chegam antes de todo mundo!",
      author: "Rodrigo Santos, Afiliado Top ML",
    },
    {
      quote: "Automatizei os disparos nos meus 4 grupos de achadinhos e minhas comissões triplicaram em apenas duas semanas.",
      author: "Camila Ferreira, Criadora de Conteúdo",
    },
    {
      quote: "A velocidade do alerta de queda de preço é surreal. Já peguei notebooks e smartphones com mais de 60% de desconto real.",
      author: "Lucas Mendonça, Comprador Inteligente",
    },
    {
      quote: "Melhor ferramenta para quem gerencia grupos de promoções. As mensagens já saem formatadas e com link de afiliado pronto.",
      author: "Beatriz Albuquerque, Administradora de Comunidades",
    },
    {
      quote: "O rastreio de categorias e a detecção de menor preço histórico me poupam mais de 3 horas por dia de garimpo manual.",
      author: "Marcos Vinicius, Especialista em E-commerce",
    },
  ];

  const [currentTestimonialIndex, setCurrentTestimonialIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTestimonialIndex((prev) => (prev + 1) % testimonials.length);
    }, 4500);
    return () => clearInterval(timer);
  }, [testimonials.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!email.trim() || !password.trim()) {
      setErrorMessage('Por favor, preencha o e-mail e a senha.');
      return;
    }

    if (password.length < 6) {
      setErrorMessage('A senha deve ter pelo menos 6 caracteres.');
      return;
    }

    setLoading(true);
    try {
      if (isRegister) {
        const data = await signUpWithEmail(email.trim(), password, fullName.trim());
        if (data.session) {
          setSuccessMessage('Conta criada com sucesso! Acessando...');
          setTimeout(() => {
            onSuccess(data.user);
          }, 600);
        } else {
          setSuccessMessage('Cadastro realizado com sucesso no Supabase! Você já pode fazer login com seu e-mail e senha.');
          setIsRegister(false);
        }
      } else {
        const data = await signInWithEmail(email.trim(), password);
        onSuccess(data.user);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Erro ao autenticar. Verifique suas credenciais.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-layout">
      {/* ─── Lado Esquerdo: Hero Branding (Figma Design) ─── */}
      <div className="login-hero-panel">
        {/* Gráfico de Ondas / Círculos Concêntricos do Radar de Fundo */}
        <div className="radar-concentric-bg">
          <div className="radar-circle circle-1" />
          <div className="radar-circle circle-2" />
          <div className="radar-circle circle-3" />
          <div className="radar-circle circle-4" />
        </div>

        <div className="login-hero-content">
          {/* Logo Radar Ofertas ML */}
          <div className="login-logo-box">
            <div className="login-logo-icon">
              <Zap size={24} fill="white" color="white" />
            </div>
            <div className="login-logo-texts">
              <span className="login-logo-title">Radar</span>
              <span className="login-logo-subtitle">Ofertas ML</span>
            </div>
          </div>

          {/* Headline & Subheadline */}
          <div className="login-headline-area">
            <h1 className="login-hero-title">
              Encontre as melhores ofertas do Mercado Livre em tempo real
            </h1>
            <p className="login-hero-desc">
              Monitore preços, receba alertas instantâneos e nunca mais perca uma oferta. Tudo automatizado para você.
            </p>
          </div>

          {/* Métricas Principais */}
          <div className="login-metrics-grid">
            <div className="login-metric-item">
              <div className="login-metric-value">10K+</div>
              <div className="login-metric-label">Usuários ativos</div>
            </div>
            <div className="login-metric-item">
              <div className="login-metric-value">75%</div>
              <div className="login-metric-label">Desconto máximo</div>
            </div>
            <div className="login-metric-item">
              <div className="login-metric-value">24/7</div>
              <div className="login-metric-label">Monitoramento</div>
            </div>
          </div>

          {/* Divisor */}
          <div className="login-divider-line" />

          {/* Depoimento / Testimonial Rotativo Automático */}
          <div className="login-testimonial-box">
            <div className="login-testimonial-card-slide" key={currentTestimonialIndex}>
              <p className="login-testimonial-quote">
                "{testimonials[currentTestimonialIndex].quote}"
              </p>
              <div className="login-testimonial-author">
                — {testimonials[currentTestimonialIndex].author}
              </div>
            </div>

            {/* Indicadores de Paginação / Dots */}
            <div className="login-testimonial-dots">
              {testimonials.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`login-testimonial-dot ${idx === currentTestimonialIndex ? 'active' : ''}`}
                  onClick={() => setCurrentTestimonialIndex(idx)}
                  title={`Depoimento ${idx + 1}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Lado Direito: Formulário de Login / Cadastro ─── */}
      <div className="login-form-panel">
        <div className="login-form-card">
          <div className="login-form-header">
            <h2 className="login-title">
              {isRegister ? 'Criar sua conta' : 'Entrar na sua conta'}
            </h2>
            <p className="login-subtitle">
              {isRegister
                ? 'Preencha os dados abaixo para começar a monitorar ofertas'
                : 'Acesse seu painel e encontre ofertas incríveis'}
            </p>
          </div>

          {/* Mensagens de Erro / Sucesso */}
          {errorMessage && (
            <div className="login-alert-error">
              <AlertCircle size={16} />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="login-alert-success">
              <Check size={16} />
              <span>{successMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="login-form-element">
            {isRegister && (
              <div className="login-input-group">
                <label className="login-label">Nome Completo</label>
                <input
                  type="text"
                  className="login-input"
                  placeholder="Seu nome completo"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoComplete="name"
                />
              </div>
            )}

            <div className="login-input-group">
              <label className="login-label">E-mail</label>
              <input
                type="email"
                className="login-input"
                placeholder="seuemail@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="login-input-group">
              <label className="login-label">Senha</label>
              <div className="login-password-wrapper">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="login-input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Ocultar senha' : 'Ver senha'}
                >
                  {showPassword ? <EyeOff size={18} color="#94a3b8" /> : <Eye size={18} color="#94a3b8" />}
                </button>
              </div>
            </div>

            {/* Manter-me conectado e Esqueci minha senha */}
            {!isRegister && (
              <div className="login-options-row">
                <label className="login-checkbox-label">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="login-checkbox"
                  />
                  <span>Manter-me conectado</span>
                </label>

                <button
                  type="button"
                  className="login-forgot-link"
                  onClick={() => alert('Para redefinir sua senha, entre em contato com o suporte ou utilize seu e-mail cadastrado.')}
                >
                  Esqueceu a senha?
                </button>
              </div>
            )}

            {/* Botão Principal de Submissão */}
            <button
              type="submit"
              className="login-btn-submit"
              disabled={loading}
            >
              {loading ? (
                <div className="login-btn-loading">
                  <span className="spinner-dots" /> Processando...
                </div>
              ) : (
                <span>{isRegister ? 'Criar Conta Grátis' : 'Entrar'}</span>
              )}
            </button>
          </form>

          {/* Alternador Entre Login e Cadastro */}
          <div className="login-footer-text">
            {isRegister ? (
              <>
                Já tem uma conta?{' '}
                <button
                  type="button"
                  className="login-switch-btn"
                  onClick={() => {
                    setIsRegister(false);
                    setErrorMessage(null);
                  }}
                >
                  Faça login
                </button>
              </>
            ) : (
              <>
                Não tem uma conta?{' '}
                <button
                  type="button"
                  className="login-switch-btn"
                  onClick={() => {
                    setIsRegister(true);
                    setErrorMessage(null);
                  }}
                >
                  Cadastre-se grátis
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
